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

// Manual attendance by faculty
router.post('/manual', (req, res) => {
  const { sessionCode, students } = req.body;
  const currentDate = new Date();
  const date = currentDate.toLocaleString();

  students.forEach(student => {
    db2.get(
      'SELECT id FROM sessions WHERE session_code = ?',
      [sessionCode],
      (err, session) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ ok: false });
        }
        if (!session) {
          return res
            .status(404)
            .json({ ok: false, message: 'Session not found' });
        }

        const sessionId = session.id;

        const stmt = db2.prepare(`
          INSERT OR IGNORE INTO attendance (session_id, student_id, status, timestamp)
          VALUES (?, ?, 'present', ?)
        `);

        students.forEach(student => {
          stmt.run(sessionId, student.id, date, function () {
            if (this.changes > 0) {
              const io = getIO();
              io.to(sessionCode).emit('attendance_update', {
                studentId: student.username,
                studentName: student.name,
                sessionCode,
                time: date,
              });
            }
          });
        });

        stmt.finalize();

        res.json({ ok: true });
      },
    );
  });
});

export default router;
