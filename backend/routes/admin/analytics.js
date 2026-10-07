import express from 'express';
import { dbAll, dbGet } from '../../utils/db.js';
import { addDays, todayLocal } from '../../utils/dates.js';
import { HttpError, wrap } from './common.js';

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const today = todayLocal();
  const from = addDays(today, -(days - 1));
  const range = [from, today];

  const totals = await dbGet(
    `SELECT
       (SELECT COUNT(*) FROM students WHERE active = 1) AS students,
       (SELECT COUNT(*) FROM students WHERE active = 1 AND face_embedding IS NOT NULL) AS enrolled,
       (SELECT COUNT(*) FROM faculties) AS faculty,
       (SELECT COUNT(*) FROM classes) AS classes,
       (SELECT COUNT(DISTINCT session_code) FROM sessions WHERE end_time IS NULL) AS liveSessions,
       (SELECT COUNT(DISTINCT session_code) FROM sessions WHERE date = ?) AS sessionsToday`,
    [today],
  );

  const overall = await dbGet(
    `SELECT COUNT(*) AS total, COALESCE(SUM(a.marked_at IS NOT NULL), 0) AS present,
            COUNT(DISTINCT s.session_code) AS sessions
     FROM attendance a JOIN sessions s ON s.id = a.session_id
     WHERE s.date BETWEEN ? AND ?`,
    range,
  );

  const daily = await dbAll(
    `SELECT s.date, COUNT(*) AS total, SUM(a.marked_at IS NOT NULL) AS present
     FROM attendance a JOIN sessions s ON s.id = a.session_id
     WHERE s.date BETWEEN ? AND ? GROUP BY s.date ORDER BY s.date`,
    range,
  );

  const byMethod = await dbAll(
    `SELECT s.method, COUNT(DISTINCT s.session_code) AS sessions
     FROM sessions s WHERE s.date BETWEEN ? AND ? GROUP BY s.method`,
    range,
  );

  const byClass = await dbAll(
    `SELECT c.id, b.abbr || ' ' || c.semester || c.section AS label,
            COUNT(*) AS total, SUM(a.marked_at IS NOT NULL) AS present
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     JOIN timetable_classes tc ON tc.timetable_id = s.timetable_id
     JOIN students_mapping sm ON sm.student_id = a.student_id AND sm.class_id = tc.class_id
     JOIN classes c ON c.id = tc.class_id
     JOIN branches b ON b.id = c.branch_id
     WHERE s.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY label`,
    range,
  );

  const bySubject = await dbAll(
    `SELECT sub.abbr AS label, COUNT(*) AS total, SUM(a.marked_at IS NOT NULL) AS present
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     JOIN timetable t ON t.id = s.timetable_id
     JOIN subjects sub ON sub.id = t.subject_id
     WHERE s.date BETWEEN ? AND ?
     GROUP BY sub.id ORDER BY label`,
    range,
  );

  const lowStudents = await dbAll(
    `SELECT st.id, st.name, st.roll_number AS roll, COUNT(*) AS total, SUM(a.marked_at IS NOT NULL) AS present
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     JOIN students st ON st.id = a.student_id
     WHERE s.date BETWEEN ? AND ? AND st.active = 1
     GROUP BY st.id HAVING total >= 3 AND present * 100.0 / total < 75
     ORDER BY present * 1.0 / total ASC, total DESC LIMIT 500`,
    range,
  );

  const recent = await dbAll(
    `SELECT s.session_code AS code, MIN(s.date) AS date, MIN(s.start_time) AS startTime,
            MAX(s.end_time IS NULL) AS live, MIN(s.method) AS method,
            MIN(sub.abbr) AS subject, MIN(f.abbr) AS faculty,
            (SELECT group_concat(DISTINCT b.abbr || ' ' || c.semester || c.section)
               FROM sessions s2 JOIN timetable_classes tc ON tc.timetable_id = s2.timetable_id
               JOIN classes c ON c.id = tc.class_id JOIN branches b ON b.id = c.branch_id
              WHERE s2.session_code = s.session_code) AS classes,
            (SELECT COUNT(*) FROM attendance a JOIN sessions s3 ON s3.id = a.session_id
              WHERE s3.session_code = s.session_code) AS total,
            (SELECT COUNT(*) FROM attendance a JOIN sessions s3 ON s3.id = a.session_id
              WHERE s3.session_code = s.session_code AND a.marked_at IS NOT NULL) AS present
     FROM sessions s
     JOIN timetable t ON t.id = s.timetable_id
     JOIN subjects sub ON sub.id = t.subject_id
     LEFT JOIN faculties f ON f.id = t.faculty_id
     WHERE s.date BETWEEN ? AND ?
     GROUP BY s.session_code ORDER BY MIN(s.date) DESC, MIN(s.id) DESC LIMIT 25`,
    range,
  );

  res.json({ ok: true, days, from, to: today, totals, overall, daily, byMethod, byClass, bySubject, lowStudents, recent });
}));

// ---- detail views behind the rows on Home ----
// One session (all its timetable rows): who was marked present and who was not.
router.get('/session/:code', wrap(async (req, res) => {
  const code = String(req.params.code);
  const info = await dbGet(
    `SELECT MIN(s.date) AS date, MIN(s.start_time) AS startTime, MAX(s.end_time) AS endTime, MAX(s.end_time IS NULL) AS live,
            MIN(s.method) AS method, MIN(sub.name) AS subject, MIN(f.name) AS faculty
     FROM sessions s JOIN timetable t ON t.id = s.timetable_id JOIN subjects sub ON sub.id = t.subject_id
     LEFT JOIN faculties f ON f.id = t.faculty_id WHERE s.session_code = ?`, [code]);
  if (!info || !info.date) throw new HttpError(404, 'not_found', 'That session no longer exists.');
  const students = await dbAll(
    `SELECT st.id, st.name, st.roll_number AS roll, MAX(a.marked_at) AS markedAt, MIN(a.method) AS method
     FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN students st ON st.id = a.student_id
     WHERE s.session_code = ? GROUP BY st.id ORDER BY st.roll_number, st.name`, [code]);
  res.json({ ok: true, code, ...info, students });
}));

// One student's attendance history inside the chosen range.
router.get('/student/:id', wrap(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const today = todayLocal();
  const from = addDays(today, -(days - 1));
  const student = await dbGet(`SELECT id, name, roll_number AS roll FROM students WHERE id = ?`, [req.params.id]);
  if (!student) throw new HttpError(404, 'not_found', 'That student no longer exists.');
  const sessions = await dbAll(
    `SELECT s.session_code AS code, s.date, s.start_time AS startTime, sub.abbr AS subject, f.abbr AS faculty,
            (a.marked_at IS NOT NULL) AS present, a.marked_at AS markedAt
     FROM attendance a JOIN sessions s ON s.id = a.session_id
     JOIN timetable t ON t.id = s.timetable_id JOIN subjects sub ON sub.id = t.subject_id
     LEFT JOIN faculties f ON f.id = t.faculty_id
     WHERE a.student_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date DESC, s.start_time DESC`,
    [student.id, from, today]);
  res.json({ ok: true, student, from, to: today, sessions: sessions.map(r => ({ ...r, present: Boolean(r.present) })) });
}));

export default router;
