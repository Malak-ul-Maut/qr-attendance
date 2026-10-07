import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAll, dbGet, dbRun } from '../../utils/db.js';
import { galleryFolderName } from '../../utils/gallery.js';
import { HttpError, wrap, clean } from './common.js';

const router = express.Router();
const GALLERY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../gallery');

function photoCount(student) {
  try {
    return fs.readdirSync(path.join(GALLERY_DIR, galleryFolderName(student))).length;
  } catch {
    return 0;
  }
}

// Active students with their class and whether a face template exists.
router.get('/', wrap(async (req, res) => {
  const rows = await dbAll(`
    SELECT s.id, s.name, s.username, s.roll_number, (s.face_embedding IS NOT NULL) AS enrolled,
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
  const students = rows.map(r => ({
    ...r,
    enrolled: Boolean(r.enrolled),
    photos: photoCount({ id: r.id, username: r.username, roll_number: r.roll_number }),
  }));
  res.json({ ok: true, students });
}));

const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const folderOf = async id => {
  const student = await dbGet(`SELECT id, username, roll_number FROM students WHERE id = ?`, [id]);
  if (!student) throw new HttpError(404, 'not_found', 'That student no longer exists.');
  return path.join(GALLERY_DIR, galleryFolderName(student));
};

// The photo files a student uploaded (names only; the image itself is fetched one by one below).
router.get('/:id/photos', wrap(async (req, res) => {
  const folder = await folderOf(req.params.id);
  let files = [];
  try { files = fs.readdirSync(folder).filter(f => IMAGE.test(f)).sort(); } catch { /* no folder yet */ }
  res.json({ ok: true, files });
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
  await dbRun(`UPDATE students SET face_embedding = NULL WHERE id = ?`, [req.params.id]);
  await dbRun(`INSERT INTO face_reset_log (student_id, reason) VALUES (?, ?)`, [req.params.id, reason]);
  res.json({ ok: true });
}));

export default router;
