import express from 'express';
import db from '../utils/db.js';
import db2 from '../utils/test-db.js';
import utils from '../utils/in-memory-db.js';
import { getIO } from '../utils/socket-io.js';

const router = express.Router();

// Verify student scan
router.post('/verify', (req, res) => {
  const currentDate = new Date();
  const date = currentDate.toLocaleString();

  let {
    studentId,
    studentName,
    token,
    sessionId,
    section,
    cameraFingerprint,
    isFaceScanned,
  } = req.body;

  if (!isFaceScanned) {
    const tokenData = utils.activeTokens[token];
    if (!tokenData)
      return res
        .status(400)
        .json({ ok: false, error: 'invalid_or_expired_token' });

    return db.get(
      `SELECT username FROM users WHERE username = ? AND section = ?`,
      [studentId, tokenData.section],
      (err, row) => {
        if (!row) return res.json({ ok: false, error: 'not_your_section' });

        sessionId = tokenData.sessionCode;
        section = tokenData.section;

        return res.json({ ok: true, sessionId, section });
      },
    );
  }

  db.get(
    `SELECT * FROM attendance WHERE (studentId = ? OR cameraFingerprint = ?) AND sessionId = ?`,
    [studentId, cameraFingerprint, sessionId],
    (err, row) => {
      if (row) {
        if (row.studentId === studentId)
          return res.status(400).json({ ok: false, error: 'already_marked' });
        if (row.cameraFingerprint === cameraFingerprint)
          return res
            .status(400)
            .json({ ok: false, error: 'duplicate_device_entry' });
      }

      db.run(
        `INSERT INTO attendance (studentId, studentName, section, timestamp, sessionId, cameraFingerprint) VALUES (?, ?, ?, ?, ?, ?)`,
        [studentId, studentName, section, date, sessionId, cameraFingerprint],
        () => {
          const io = getIO();
          io.to(sessionId).emit('attendance_update', {
            studentId,
            studentName,
            section,
            sessionId,
            time: currentDate.toLocaleTimeString(),
          });
          return res.json({
            ok: true,
            message: 'Attendance recorded',
          });
        },
      );
    },
  );
});

// Manual attendance by faculty.
// Resolve each student to the session row whose timetable class matches the student.
router.post('/manual', async (req, res) => {
  const { sessionCode, students = [] } = req.body;
  const timestamp = new Date().toLocaleString();

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }

  try {
    const sessionRows = await allDb2(
      `
      SELECT sessions.id AS session_id, timetable.class_id
      FROM sessions
      JOIN timetable ON timetable.id = sessions.timetable_id
      WHERE sessions.session_code = ?
      `,
      [sessionCode],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }

    const io = getIO();
    let added = 0;

    for (const student of students) {
      const dbStudent = await getDb2(
        `SELECT id, class_id FROM students WHERE id = ?`,
        [student.id],
      );
      if (!dbStudent) continue;

      const session = sessionRows.find(
        row => row.class_id === dbStudent.class_id,
      );
      if (!session) continue;

      const changes = await insertAttendance(
        session.session_id,
        dbStudent.id,
        timestamp,
      );

      if (changes > 0) {
        added++;
        io.to(sessionCode).emit('attendance_update', {
          studentId: dbStudent.id,
          studentName: student.name,
          sessionCode,
          time: timestamp,
          method: 'manual',
        });
      }
    }

    return res.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

function allDb2(sql, params) {
  return new Promise((resolve, reject) => {
    db2.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getDb2(sql, params) {
  return new Promise((resolve, reject) => {
    db2.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function insertAttendance(sessionId, studentId, timestamp) {
  return new Promise((resolve, reject) => {
    db2.run(
      `INSERT OR IGNORE INTO attendance (session_id, student_id, status, timestamp)
       VALUES (?, ?, 'present', ?)`,
      [sessionId, studentId, timestamp],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes);
      },
    );
  });
}

export default router;
