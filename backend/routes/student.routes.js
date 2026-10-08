import express from 'express';
import { dbAll, dbGet, dbRun } from '../utils/db.js';
import { requireStudent } from '../utils/student-auth.js';
import { decodeEmbedding, encodeEmbedding } from '../utils/embedding.js';
import { decodeUploadedImage } from '../utils/images.js';
import { galleryFolderName } from '../utils/gallery.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { addDays, isValidDate, weekdayName } from '../utils/dates.js';

// Everything a signed-in student can read or change about themselves.
// Passwords are still plain text for now (hashing comes later), so the password
// check below compares plain text on purpose.
const router = express.Router();
router.use(requireStudent);

const DEFAULT_PASSWORD = 'password';
const MIN_PASSWORD_LENGTH = 8;
const ATTENDANCE_TARGET = 75; // overall percentage a student must keep
const CLOSE_MARGIN = 5; // within this many points above the target counts as "close"
const MAX_RECORDS = 500;

// Tests replace this to pin "now".
export const clock = { now: () => new Date() };

// ---- face enrolment settings ----
export const FACE_MODEL = 'w600k_mbf'; // the browser model; the CCTV service makes its own embeddings from the photos
const MIN_PHOTOS = 6;
const MAX_PHOTOS = 10;
// A new template this close to ANOTHER student's is treated as the same face enrolled twice.
// Starting value: tune it on real data (the log line below shows near misses).
const DUPLICATE_THRESHOLD = Number(process.env.FACE_DUPLICATE_THRESHOLD) || 0.6;
const ENROL_ATTEMPTS_PER_HOUR = 6;
const GALLERY_DIR = process.env.GALLERY_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../gallery');
const SELF_PHOTO = /^self_\d+\.(jpg|png|webp)$/;
const enrolAttempts = new Map(); // student id -> [timestamps]
const enrolling = new Set(); // student ids with a save in progress

const pad = n => String(n).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localMinutes = d => d.getHours() * 60 + d.getMinutes();
const toMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// SQLite datetime('now') is UTC without a zone marker. The API always says Z.
const utcIso = value => (value ? `${String(value).replace(' ', 'T')}Z` : null);

// ---------- the student's current class ----------
// Newest academic session, then highest semester, as the admin list does.
function currentClass(studentId) {
  return dbGet(
    `
    SELECT sm.class_id AS classId, sm.batch,
      c.semester, c.section, c.academic_session AS academicSession, c.counsellor,
      b.abbr AS branch, b.name AS branchName,
      co.abbr AS course, co.name AS courseName,
      CASE WHEN r.id IS NULL THEN NULL ELSE r.block || '-' || r.number END AS homeRoom
    FROM students_mapping sm
    JOIN classes c ON c.id = sm.class_id
    JOIN branches b ON b.id = c.branch_id
    JOIN courses co ON co.id = b.course_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE sm.student_id = ?
    ORDER BY c.academic_session DESC, c.semester DESC, sm.id DESC
    LIMIT 1
    `,
    [studentId],
  );
}

// ---------- GET /me ----------
router.get('/me', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT name, username, roll_number AS rollNumber, college_email AS email,
         phone_number AS phone, year_of_passing AS yearOfPassing,
         password_hash AS password, face_embedding IS NOT NULL AS hasFace
       FROM students WHERE id = ?`,
      [req.student.id],
    );
    const klass = await currentClass(req.student.id);
    return res.json({
      ok: true,
      name: row.name,
      username: row.username,
      rollNumber: row.rollNumber,
      email: row.email,
      phone: row.phone,
      yearOfPassing: row.yearOfPassing,
      class: klass || null, // null: not assigned to a class yet
      faceEnrolled: Boolean(row.hasFace),
      mustChangePassword: row.password === DEFAULT_PASSWORD,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------- GET /schedule ----------
// ?date=YYYY-MM-DD (default today) for one day, ?week=1 for Monday-Friday of that date's week.
// Each row says what the student can do about that period, decided with the SERVER clock.
router.get('/schedule', async (req, res) => {
  const now = clock.now();
  const today = localDate(now);
  const date = req.query.date === undefined ? today : String(req.query.date);
  if (!isValidDate(date))
    return res.status(400).json({ ok: false, error: 'invalid_date' });

  try {
    const klass = await currentClass(req.student.id);
    const base = {
      ok: true,
      serverNow: now.toISOString(),
      nowTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`, // server-local, same clock as the slot times
      today,
      class: klass || null,
    };
    if (!klass) return res.json({ ...base, assigned: false, rows: [], days: [] });

    if (req.query.week === '1') {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
      const monday = addDays(date, -((dow + 6) % 7));
      const days = [];
      for (let i = 0; i < 5; i++) {
        const day = addDays(monday, i);
        days.push({
          date: day,
          day: weekdayName(day),
          rows: await scheduleRows(req.student.id, klass, day, now),
        });
      }
      return res.json({
        ...base,
        assigned: true,
        days,
        timetableChange: await upcomingChange(klass.classId, today),
      });
    }

    const rows = await scheduleRows(req.student.id, klass, date, now);
    return res.json({
      ...base,
      assigned: true,
      date,
      day: weekdayName(date), // null on a weekend
      rows,
      nextClassDate: rows.length ? null : await nextClassDate(klass, date),
      timetableChange: await upcomingChange(klass.classId, today),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// Timetable rows in force on `date` for this student's class (and batch), with live state.
async function scheduleRows(studentId, klass, date, now) {
  const day = weekdayName(date);
  if (!day) return [];

  const rows = await dbAll(
    `
    SELECT t.id AS timetableId, sl.label AS slot, sl.start_time AS startTime,
      sl.end_time AS endTime, sub.id AS subjectId, sub.code, sub.name, sub.abbr,
      sub.takes_attendance AS takesAttendance, f.name AS faculty,
      CASE WHEN r.id IS NULL THEN NULL ELSE r.block || '-' || r.number END AS room,
      MAX(tc.batch IS NOT NULL) AS forBatch,
      s.id AS sessionId, s.method, s.end_time AS sessionEnd,
      a.id AS attendanceId, a.marked_at AS markedAt, a.method AS markedMethod
    FROM timetable t
    JOIN timetable_classes tc ON tc.timetable_id = t.id
      AND tc.class_id = ?
      AND (tc.batch IS NULL OR ? IS NULL OR tc.batch = ?)
    JOIN slots sl ON sl.id = t.slot_id
    JOIN subjects sub ON sub.id = t.subject_id
    LEFT JOIN faculties f ON f.id = t.faculty_id
    LEFT JOIN rooms r ON r.id = t.room_id
    LEFT JOIN sessions s ON s.timetable_id = t.id AND s.date = ?
    LEFT JOIN attendance a ON a.session_id = s.id AND a.student_id = ?
    WHERE t.day = ? AND t.valid_from <= ? AND (t.valid_to IS NULL OR t.valid_to >= ?)
    GROUP BY t.id
    ORDER BY sl.start_time, t.id
    `,
    [klass.classId, klass.batch, klass.batch, date, studentId, day, date, date],
  );

  const today = localDate(now);
  const minutes = localMinutes(now);
  return rows.map(r => {
    const batchPending = Boolean(r.forBatch) && klass.batch === null;
    return {
      timetableId: r.timetableId,
      slot: r.slot,
      startTime: r.startTime,
      endTime: r.endTime,
      subject: { id: r.subjectId, code: r.code, name: r.name, abbr: r.abbr },
      faculty: r.faculty,
      room: r.room,
      forBatch: Boolean(r.forBatch),
      batchPending, // a lab for a batch, but the student has no batch yet
      state: batchPending ? 'batch_pending' : cardState(r, date, today, minutes),
      markedAt: utcIso(r.markedAt),
      markedMethod: r.markedMethod,
    };
  });
}

// upcoming, waiting, open_qr, open_camera, marked, missed, not_held, not_tracked, not_on_roster
function cardState(r, date, today, minutes) {
  if (!r.takesAttendance) return 'not_tracked';

  if (r.sessionId) {
    // An open session from an earlier day was never finalised: it counts as ended.
    const ended = r.sessionEnd !== null || date < today;
    if (ended) {
      if (!r.attendanceId) return 'not_held'; // not on that session's roster
      return r.markedAt ? 'marked' : 'missed';
    }
    if (!r.attendanceId) return 'not_on_roster';
    if (r.markedAt) return 'marked';
    return r.method === 'qr' ? 'open_qr' : 'open_camera';
  }

  if (date > today) return 'upcoming';
  if (date < today) return 'not_held';
  if (minutes < toMinutes(r.startTime)) return 'upcoming';
  if (minutes < toMinutes(r.endTime)) return 'waiting';
  return 'not_held';
}

async function nextClassDate(klass, from) {
  for (let i = 1; i <= 14; i++) {
    const date = addDays(from, i);
    if (!weekdayName(date)) continue;
    const row = await dbGet(
      `SELECT 1 AS found FROM timetable t
       JOIN timetable_classes tc ON tc.timetable_id = t.id AND tc.class_id = ?
       WHERE t.day = ? AND t.valid_from <= ? AND (t.valid_to IS NULL OR t.valid_to >= ?)
       LIMIT 1`,
      [klass.classId, weekdayName(date), date, date],
    );
    if (row) return date;
  }
  return null;
}

// A newer timetable starting soon, so the page can say "timetable changes on ...".
async function upcomingChange(classId, today) {
  const row = await dbGet(
    `SELECT MIN(t.valid_from) AS startsOn FROM timetable t
     JOIN timetable_classes tc ON tc.timetable_id = t.id AND tc.class_id = ?
     WHERE t.valid_from > ? AND t.valid_from <= ?`,
    [classId, today, addDays(today, 14)],
  );
  return row?.startsOn ? { startsOn: row.startsOn } : null;
}

// ---------- GET /attendance ----------
// Only sessions that have ended count (an open session's unmarked rows are not absences yet),
// subjects that do not take attendance are left out, and every period is one class, so a
// two-period lab counts twice. Without `subject`, `from` or `to` only totals are returned.
router.get('/attendance', async (req, res) => {
  const today = localDate(clock.now());
  const { subject, from, to } = req.query;
  if ((from !== undefined && !isValidDate(String(from))) ||
      (to !== undefined && !isValidDate(String(to))) ||
      (subject !== undefined && !/^\d+$/.test(String(subject))))
    return res.status(400).json({ ok: false, error: 'invalid_filter' });

  try {
    const rows = await dbAll(
      `
      SELECT sub.id AS subjectId, sub.code, sub.name, sub.abbr,
        GROUP_CONCAT(DISTINCT f.name) AS faculty,
        COUNT(*) AS held, SUM(a.marked_at IS NOT NULL) AS attended
      FROM attendance a
      JOIN sessions s ON s.id = a.session_id
      JOIN timetable t ON t.id = s.timetable_id
      JOIN subjects sub ON sub.id = t.subject_id
      LEFT JOIN faculties f ON f.id = t.faculty_id
      WHERE a.student_id = ? AND sub.takes_attendance = 1
        AND (s.end_time IS NOT NULL OR s.date < ?)
      GROUP BY sub.id
      ORDER BY sub.name
      `,
      [req.student.id, today],
    );

    const subjects = rows.map(r => ({
      subjectId: r.subjectId,
      code: r.code,
      name: r.name,
      abbr: r.abbr,
      faculty: r.faculty,
      held: r.held,
      attended: r.attended,
      percent: percent(r.attended, r.held),
    }));
    const held = subjects.reduce((n, s) => n + s.held, 0);
    const attended = subjects.reduce((n, s) => n + s.attended, 0);
    const out = {
      ok: true,
      today,
      overall: overall(attended, held),
      // lowest first, subjects with nothing held last
      subjects: subjects.sort(
        (a, b) => (a.percent ?? 101) - (b.percent ?? 101) || a.name.localeCompare(b.name),
      ),
    };

    if (subject !== undefined || from !== undefined || to !== undefined) {
      const where = ['a.student_id = ?', 'sub.takes_attendance = 1', '(s.end_time IS NOT NULL OR s.date < ?)'];
      const params = [req.student.id, today];
      if (subject !== undefined) { where.push('sub.id = ?'); params.push(Number(subject)); }
      if (from !== undefined) { where.push('s.date >= ?'); params.push(String(from)); }
      if (to !== undefined) { where.push('s.date <= ?'); params.push(String(to)); }
      const records = await dbAll(
        `
        SELECT s.date, sl.label AS slot, sl.start_time AS startTime, sl.end_time AS endTime,
          sub.id AS subjectId, sub.name AS subject, a.marked_at AS markedAt, a.method
        FROM attendance a
        JOIN sessions s ON s.id = a.session_id
        JOIN timetable t ON t.id = s.timetable_id
        JOIN slots sl ON sl.id = t.slot_id
        JOIN subjects sub ON sub.id = t.subject_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.date DESC, sl.start_time DESC
        LIMIT ${MAX_RECORDS}
        `,
        params,
      );
      out.records = records.map(r => ({
        date: r.date,
        slot: r.slot,
        startTime: r.startTime,
        endTime: r.endTime,
        subjectId: r.subjectId,
        subject: r.subject,
        status: r.markedAt ? 'present' : 'absent',
        method: r.markedAt ? r.method : null,
        markedAt: utcIso(r.markedAt),
      }));
    }
    return res.json(out);
  } catch (err) {
    return fail(res, err);
  }
});

// null (not 0) when nothing has been held, so the page shows "No classes yet".
function percent(attended, held) {
  return held === 0 ? null : Math.round((attended / held) * 1000) / 10;
}

// attend `needToAttend` more classes in a row to reach the target, or you can still miss `canMiss`.
export function overall(attended, held) {
  const pct = percent(attended, held);
  // 75% means 3 of every 4 classes: attended + x >= 0.75 * (held + x)  =>  x = 3*held - 4*attended
  const needToAttend = Math.max(0, 3 * held - 4 * attended);
  const canMiss = Math.max(0, Math.floor((4 * attended - 3 * held) / 3));
  let status = 'none';
  if (held > 0)
    status = pct < ATTENDANCE_TARGET ? 'below' : pct < ATTENDANCE_TARGET + CLOSE_MARGIN ? 'close' : 'safe';
  return {
    held,
    attended,
    percent: pct,
    target: ATTENDANCE_TARGET,
    status,
    needToAttend: pct !== null && pct < ATTENDANCE_TARGET ? needToAttend : 0,
    canMiss: pct !== null && pct >= ATTENDANCE_TARGET ? canMiss : 0,
  };
}

// ---------- POST /password ----------
router.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string')
    return res.status(400).json({ ok: false, error: 'missing_fields' });

  try {
    const row = await dbGet(
      `SELECT password_hash AS password, username, roll_number AS rollNumber FROM students WHERE id = ?`,
      [req.student.id],
    );
    if (row.password !== currentPassword)
      return res.status(403).json({ ok: false, error: 'wrong_password' });

    const problem = passwordProblem(newPassword, row);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    await dbRun(`UPDATE students SET password_hash = ? WHERE id = ?`, [newPassword, req.student.id]);
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

function passwordProblem(next, row) {
  const lower = next.toLowerCase();
  if (next.length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (next === row.password) return 'password_unchanged';
  if (lower === DEFAULT_PASSWORD) return 'password_is_default';
  if (lower === String(row.username).toLowerCase()) return 'password_is_username';
  if (row.rollNumber && lower === String(row.rollNumber).toLowerCase())
    return 'password_is_roll_number';
  return null;
}

// ---------- GET /face/template ----------
// Only the signed-in student's own template. Stage 6 removes this once matching moves to the server.
router.get('/face/template', async (req, res) => {
  try {
    const row = await dbGet(`SELECT face_embedding FROM students WHERE id = ?`, [req.student.id]);
    if (!row?.face_embedding)
      return res.status(404).json({ ok: false, error: 'face_not_enrolled' });
    return res.json(decodeEmbedding(row.face_embedding));
  } catch (err) {
    return fail(res, err);
  }
});

// ---------- GET /face ----------
router.get('/face', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT face_embedding IS NOT NULL AS enrolled, face_enrolled_at AS enrolledAt,
         face_embedding_model AS model, password_hash AS password FROM students WHERE id = ?`,
      [req.student.id],
    );
    return res.json({
      ok: true,
      enrolled: Boolean(row.enrolled),
      enrolledAt: utcIso(row.enrolledAt),
      model: row.model,
      photoCount: (await selfPhotos(req.student)).length,
      minPhotos: MIN_PHOTOS,
      maxPhotos: MAX_PHOTOS,
      passwordChangeRequired: row.password === DEFAULT_PASSWORD,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------- POST /face ----------
// Body: { images: [{ dataUrl }], descriptor: [512 numbers], model }.
// The photos go to gallery/ (the CCTV service builds its own embeddings from them) and the
// descriptor to students.face_embedding (used by the phone check). Once enrolled it is locked:
// only an admin reset lets a student enrol again.
router.post('/face', async (req, res) => {
  const id = req.student.id;
  if (enrolling.has(id)) return res.status(409).json({ ok: false, error: 'enrolment_in_progress' });
  enrolling.add(id);
  let written = [];
  try {
    const row = await dbGet(
      `SELECT face_embedding IS NOT NULL AS enrolled, password_hash AS password FROM students WHERE id = ?`,
      [id],
    );
    if (row.password === DEFAULT_PASSWORD)
      return res.status(403).json({ ok: false, error: 'password_change_required' });
    if (row.enrolled) return res.status(409).json({ ok: false, error: 'already_enrolled' });

    const { images, descriptor, model } = req.body || {};
    if (model !== FACE_MODEL) return res.status(400).json({ ok: false, error: 'wrong_face_model' });
    if (!Array.isArray(images) || images.length < MIN_PHOTOS || images.length > MAX_PHOTOS)
      return res.status(400).json({ ok: false, error: 'wrong_photo_count' });
    const decoded = images.map(decodeUploadedImage);
    if (decoded.includes(null)) return res.status(400).json({ ok: false, error: 'invalid_image' });

    const vector = normalizedDescriptor(descriptor);
    if (!vector) return res.status(400).json({ ok: false, error: 'invalid_face_descriptor' });

    // The duplicate check tells a caller "this face exists", so it is rate limited: only attempts
    // that got this far (a well-formed submission) count.
    const cutoff = Date.now() - 3600000;
    const recent = (enrolAttempts.get(id) || []).filter(t => t > cutoff);
    if (recent.length >= ENROL_ATTEMPTS_PER_HOUR)
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    enrolAttempts.set(id, [...recent, Date.now()]);

    // Is this face already enrolled under another account?
    const others = await dbAll(
      `SELECT id, face_embedding FROM students WHERE face_embedding IS NOT NULL AND id <> ?`,
      [id],
    );
    let best = -1;
    for (const other of others) {
      const sim = cosine(vector, decodeEmbedding(other.face_embedding));
      if (sim > best) best = sim;
      if (sim >= DUPLICATE_THRESHOLD)
        return res.status(409).json({ ok: false, error: 'face_already_enrolled' }); // never says whose
    }
    if (best >= 0.45) console.warn(`[enrol] student ${id}: closest other template ${best.toFixed(3)} (limit ${DUPLICATE_THRESHOLD})`);

    // Photos first (as .part files), then swap in, then the database. Any failure removes what was written.
    const folder = path.join(GALLERY_DIR, galleryFolderName(await dbGet(
      `SELECT id, name, roll_number FROM students WHERE id = ?`, [id])));
    await fs.mkdir(folder, { recursive: true });
    const stamp = Date.now().toString(36);
    const parts = [];
    for (let i = 0; i < decoded.length; i++) {
      const part = path.join(folder, `.enrol_${stamp}_${i + 1}.part`);
      await fs.writeFile(part, decoded[i].buffer);
      parts.push([part, path.join(folder, `self_${i + 1}${decoded[i].extension}`)]);
      written.push(part);
    }
    // only this student's earlier self-enrolment photos are replaced; photos an admin added stay
    for (const name of await fs.readdir(folder)) if (SELF_PHOTO.test(name)) await fs.rm(path.join(folder, name));
    written = [];
    for (const [part, final] of parts) { await fs.rename(part, final); written.push(final); }

    await dbRun(
      `UPDATE students SET face_embedding = ?, face_embedding_model = ?, face_enrolled_at = datetime('now') WHERE id = ?`,
      [encodeEmbedding(Array.from(vector)), FACE_MODEL, id],
    );
    written = [];
    return res.json({ ok: true, photoCount: decoded.length });
  } catch (err) {
    for (const file of written) await fs.rm(file, { force: true }).catch(() => {});
    return fail(res, err);
  } finally {
    enrolling.delete(id);
  }
});

async function selfPhotos(student) {
  try {
    const folder = path.join(GALLERY_DIR, galleryFolderName({ id: student.id, name: student.name, roll_number: student.roll_number }));
    return (await fs.readdir(folder)).filter(n => SELF_PHOTO.test(n));
  } catch {
    return [];
  }
}

// 512 finite numbers that are (close to) unit length; returned as a unit-length Float64Array.
function normalizedDescriptor(values) {
  if (!Array.isArray(values) || values.length !== 512) return null;
  let norm = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm < 0.5 || norm > 1.5) return null; // the browser sends a normalised vector
  return Float64Array.from(values, v => v / norm);
}

function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function fail(res, err) {
  console.error(err);
  return res.status(500).json({ ok: false, error: 'database_error' });
}

export default router;
