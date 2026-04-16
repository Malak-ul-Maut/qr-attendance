import express from 'express';
import utils from '../utils/in-memory-db.js';
import db from '../utils/db.js';
import db2 from '../utils/test-db.js';

// --------------- Session Routes ----------------
const router = express.Router();
const sessions = {};

// Get slots
router.get('/slots', (req, res) => {
  const { date, faculty_id } = req.query;
  const day = convertToDay(date);

  db2.all(
    `
    SELECT 
    DISTINCT slots.id,
    slots.label,
    slots.start_time,
    slots.end_time
    FROM timetable
    JOIN slots ON timetable.slot_id = slots.id
    WHERE timetable.day = ? 
    AND timetable.faculty_id = ?;
  `,
    [day, faculty_id],
    (err, rows) => {
      if (err) console.error(err);
      return res.json(rows);
    },
  );
});

// Get students
router.get('/students', (req, res) => {
  const { date, faculty_id } = req.query;
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const day = days[new Date(date).getDay()];

  db2.all(
    `
  SELECT 
  students.id,
  students.roll_number,
  students.class_id
  FROM timetable
  JOIN students ON students.class_id = timetable.class_id
  WHERE timetable.day = ?
  AND timetable.faculty_id = ?;
  `,
    [day, faculty_id],
    (err, rows) => {
      if (err) console.error(err);
      return res.json(rows);
    },
  );
});

// Start session
router.post('/start', (req, res) => {
  const { date, slotId, facultyId } = req.body;
  const day = convertToDay(date);
  const sessionCode = 'sess_' + Math.random().toString(36).slice(2);

  db2.all(
    `
    SELECT 
    timetable.id
    FROM timetable
    WHERE timetable.day = ?
    AND timetable.slot_id = ? 
    AND timetable.faculty_id = ?;
  `,
    [day, slotId, facultyId],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }

      const timetableIds = rows.map(r => r.id);
      timetableIds.forEach(id => {
        db2.run(
          `INSERT INTO sessions (session_code, timetable_id, date, start_time) VALUES (?, ?, ?, ?)`,
          [sessionCode, id, date, facultyId],
        );
      });
    },
  );

  let token = createSessionToken(sessionCode, 3);
  return res.json({ ok: true, sessionCode, token });
});

// Issue a fresh token for an existing sessionId
router.post('/token', (req, res) => {
  const { sessionCode } = req.body;

  db2.get(
    `
    SELECT * FROM sessions WHERE session_code = ?`,
    [sessionCode],
    (err, row) => {
      if (!row)
        return res.status(400).json({ ok: false, error: 'invalid_session' });

      if (row.end_time !== null)
        return res.status(400).json({ ok: false, error: 'session_ended' });
      let token = createSessionToken(sessionCode, 3);
      return res.json({ ok: true, token });
    },
  );
});

// Finalize attendance
router.post('/finalize', (req, res) => {
  const { sessionId, keepStudentIds } = req.body;
  sessions[sessionId].active = false;
  const placeholders = keepStudentIds.map(() => '?').join(','); // '?,?,?,?,....,?'

  db.run(
    `UPDATE sessions SET endTime = datetime('now'), status = 'ended' WHERE sessionId = ?`,
    [sessionId],
  );

  if (keepStudentIds.length === 0) {
    utils.teacherSockets.forEach(sock =>
      sock.emit('session_finalized', { sessionId }),
    );
    return res.json({ ok: true, message: 'Finalized (no students kept)' });
  }

  db.run(
    `UPDATE attendance SET removed = 0 WHERE sessionId = ? AND studentId IN (${placeholders})`,
    [sessionId, ...keepStudentIds],
    () => {
      return res.json({
        ok: true,
        message: 'Finalized',
        keptCount: keepStudentIds.length,
      });
    },
  );
});

function createSessionToken(sessionCode, expiresInSeconds) {
  const token = Math.random().toString(36).slice(2);
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  utils.activeTokens[token] = { sessionCode, expiresAt };

  setTimeout(() => delete utils.activeTokens[token], expiresInSeconds * 1000);
  return token;
}

function convertToDay(date) {
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  return days[new Date(date).getDay()];
}

export default router;
