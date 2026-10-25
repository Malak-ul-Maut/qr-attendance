import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAll, dbGet, dbRun } from '../../utils/db.js';
import { GALLERY_DIR, IMAGE_FILE, galleryFolderName, hasGalleryPhotos } from '../../utils/gallery.js';
import { refreshEnrolmentQa } from '../cctv.routes.js';
import { HttpError, wrap, clean, classroomMap } from './common.js';

const router = express.Router();

function photoCount(student) {
  try {
    return fs.readdirSync(path.join(GALLERY_DIR, galleryFolderName(student))).filter(name => IMAGE_FILE.test(name)).length;
  } catch {
    return 0;
  }
}

// The photo check's verdict, short enough for the list: { status: 'ok' | 'review', reasons: [...] } or null.
function summariseQa(json) {
  if (!json) return null;
  try {
    const qa = JSON.parse(json);
    return { status: qa.status, reasons: (qa.reasons || []).slice(0, 6), consistency: qa.consistency, referenceSimilarity: qa.reference_similarity };
  } catch {
    return null;
  }
}

// Active students with their class and whether a face template exists.
router.get('/', wrap(async (req, res) => {
  const rows = await dbAll(`
    SELECT s.id, s.name, s.username, s.roll_number, (s.face_embedding IS NOT NULL) AS enrolled,
           CASE WHEN s.face_status IS NOT NULL THEN s.face_status
                WHEN s.face_embedding IS NOT NULL THEN 'approved' ELSE 'none' END AS faceStatus,
           s.face_reject_reason AS rejectReason, s.face_enrolled_at AS submittedAt, s.face_reviewed_at AS reviewedAt,
           s.face_qa AS qaJson,
           sm.class_id AS classId, c.academic_session AS session,
           CASE WHEN c.id IS NULL THEN '' ELSE b.abbr || ' ' || c.semester || c.section END AS classLabel
    FROM students s
    LEFT JOIN students_mapping sm ON sm.id = (
      SELECT sm2.id FROM students_mapping sm2 JOIN classes c2 ON c2.id = sm2.class_id
      WHERE sm2.student_id = s.id
      ORDER BY c2.academic_session DESC, c2.semester DESC, sm2.id DESC LIMIT 1)
    LEFT JOIN classes c ON c.id = sm.class_id
    LEFT JOIN branches b ON b.id = c.branch_id
    WHERE s.active = 1
    ORDER BY s.name`);
  const rooms = await classroomMap();
  const students = rows.map(({ qaJson, ...r }) => ({
    ...r,
    qa: summariseQa(qaJson),
    // Photos are in the folder but the student never enrolled in the app: the camera still searches for them.
    galleryOnly: r.faceStatus === 'none' && hasGalleryPhotos({ id: r.id, name: r.name, roll_number: r.roll_number }),
    classroomKey: rooms.get(r.classId)?.key ?? '',
    classroomLabel: rooms.get(r.classId)?.label ?? '',
    enrolled: Boolean(r.enrolled),
    photos: photoCount({ id: r.id, name: r.name, roll_number: r.roll_number }),
  }));
  res.json({ ok: true, students });
}));

const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;

// Runs the photo check again (for photos an admin added by hand, or after changing thresholds).
router.post('/:id/check', wrap(async (req, res) => {
  const student = await dbGet(`SELECT id, name, roll_number FROM students WHERE id = ?`, [req.params.id]);
  if (!student) throw new HttpError(404, 'not_found', 'That student no longer exists.');
  try {
    const qa = await refreshEnrolmentQa(student);
    res.json({ ok: true, qa: summariseQa(JSON.stringify(qa)) });
  } catch (error) {
    throw new HttpError(503, 'check_unavailable', 'The photo check could not run. Is the recognition service up?');
  }
}));
const folderOf = async id => {
  const student = await dbGet(`SELECT id, name, roll_number FROM students WHERE id = ?`, [id]);
  if (!student) throw new HttpError(404, 'not_found', 'That student no longer exists.');
  return path.join(GALLERY_DIR, galleryFolderName(student));
};

// The photo files a student uploaded (names only; the image itself is fetched one by one below).
// One photo per pose: older uploads saved the best AND the runner-up frame of every pose, and showing both made the grid
// twice as long for no gain. The sharpest (rank 1) of each pose is shown; photos with no pose on record (added by hand,
// or from before poses were saved) are all shown. `hidden` says how many runner-ups were left out.
router.get('/:id/photos', wrap(async (req, res) => {
  const folder = await folderOf(req.params.id);
  let files = [];
  try { files = fs.readdirSync(folder).filter(f => IMAGE.test(f)).sort(); } catch { /* no folder yet */ }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, 'self_meta.dat'), 'utf8')).files || {}; } catch { /* no record */ }
  const best = new Map(); // pose -> file
  for (const file of files) {
    const shot = meta[file]?.shot;
    if (!shot) continue;
    const kept = best.get(shot);
    if (!kept || (meta[file].rank ?? 1) < (meta[kept].rank ?? 1)) best.set(shot, file);
  }
  const shown = files.filter(file => !meta[file]?.shot || best.get(meta[file].shot) === file);
  res.json({ ok: true, files: shown, photos: shown.map(file => ({ file, shot: meta[file]?.shot || null })), hidden: files.length - shown.length });
}));

router.get('/:id/photos/:file', wrap(async (req, res) => {
  const folder = await folderOf(req.params.id);
  const file = path.basename(String(req.params.file));
  const full = path.join(folder, file);
  if (file !== req.params.file || !IMAGE.test(file) || !fs.existsSync(full)) throw new HttpError(404, 'not_found', 'That photo is not available.');
  res.sendFile(full);
}));

// Clears the face template so the student has to upload photos again. A reason is required and kept in a log.
router.post('/:id/reset', wrap(async (req, res) => {
  const reason = clean(req.body?.reason);
  if (!reason) throw new HttpError(400, 'required_value_missing', 'Choose a reason for the reset.');
  if (reason.length > 300) throw new HttpError(400, 'invalid_value', 'Keep the reason under 300 characters.');
  await dbRun(`CREATE TABLE IF NOT EXISTS face_reset_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, reason TEXT NOT NULL, reset_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // The student's own app photos go, as in a rejection (photos an admin added by hand and CCTV crops stay).
  const student = await dbGet(`SELECT id, name, roll_number FROM students WHERE id = ?`, [req.params.id]);
  if (student) {
    const folder = path.join(GALLERY_DIR, galleryFolderName(student));
    try { for (const f of fs.readdirSync(folder)) if (SELF_PHOTO.test(f) || f === 'self_meta.dat' || f === 'self_meta.json') fs.rmSync(path.join(folder, f), { force: true }); } catch { /* no folder */ }
  }
  await dbRun(`UPDATE students SET face_embedding = NULL, face_status = NULL, face_reviewed_at = NULL,
                 face_reviewed_by = NULL, face_reject_reason = NULL, face_qa = NULL, face_qa_at = NULL WHERE id = ?`, [req.params.id]);
  await dbRun(`INSERT INTO face_reset_log (student_id, reason) VALUES (?, ?)`, [req.params.id, reason]);
  res.json({ ok: true });
}));

// ---------------- Review: photos only count for QR / CCTV once an admin approves them ----------------
const SELF_PHOTO = /^self_\d+\.(jpe?g|png|webp)$/;
const ensureReviewLog = () => dbRun(`CREATE TABLE IF NOT EXISTS face_review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT,
  admin TEXT, reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

async function approveOne(id, admin) {
  const done = await dbRun(
    `UPDATE students SET face_status = 'approved', face_reviewed_at = datetime('now'), face_reviewed_by = ?, face_reject_reason = NULL
     WHERE id = ? AND active = 1 AND face_embedding IS NOT NULL AND face_status = 'pending'`, [admin, id]);
  if (done.changes) await dbRun(`INSERT INTO face_review_log (student_id, action, admin) VALUES (?, 'approved', ?)`, [id, admin]);
  return done.changes;
}

router.post('/approve-bulk', wrap(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new HttpError(400, 'required_value_missing', 'Select the students to approve.');
  await ensureReviewLog();
  let approved = 0;
  for (const id of ids) approved += await approveOne(id, req.adminUsername);
  res.json({ ok: true, approved, skipped: ids.length - approved });
}));

router.post('/:id/approve', wrap(async (req, res) => {
  await ensureReviewLog();
  const changed = await approveOne(Number(req.params.id), req.adminUsername);
  if (!changed) throw new HttpError(409, 'not_pending', 'These photos are not waiting for review any more. Refresh the list.');
  res.json({ ok: true });
}));

// Rejecting throws the submission away (photos and template) so the student can take new ones;
// the reason is shown to the student.
router.post('/:id/reject', wrap(async (req, res) => {
  const reason = clean(req.body?.reason);
  if (!reason) throw new HttpError(400, 'required_value_missing', 'Choose or write a reason for the student.');
  if (reason.length > 200) throw new HttpError(400, 'invalid_value', 'Keep the reason under 200 characters.');
  const student = await dbGet(`SELECT id, name, roll_number, face_status FROM students WHERE id = ? AND active = 1`, [req.params.id]);
  if (!student) throw new HttpError(404, 'not_found', 'That student no longer exists.');
  if (student.face_status !== 'pending') throw new HttpError(409, 'not_pending', 'These photos are not waiting for review any more. Refresh the list.');
  await ensureReviewLog();
  const folder = path.join(GALLERY_DIR, galleryFolderName(student));
  try { for (const f of fs.readdirSync(folder)) if (SELF_PHOTO.test(f)) fs.rmSync(path.join(folder, f), { force: true }); } catch { /* no folder */ }
  await dbRun(`UPDATE students SET face_embedding = NULL, face_status = 'rejected', face_reviewed_at = datetime('now'),
                 face_reviewed_by = ?, face_reject_reason = ? WHERE id = ?`, [req.adminUsername, reason, student.id]);
  await dbRun(`INSERT INTO face_review_log (student_id, action, reason, admin) VALUES (?, 'rejected', ?, ?)`, [student.id, reason, req.adminUsername]);
  res.json({ ok: true });
}));

export default router;
