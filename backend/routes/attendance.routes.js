import express from 'express';
import db from '../utils/db.js';
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

        sessionId = tokenData.sessionId;
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
  const { sessionId, students, section } = req.body;
  const currentDate = new Date();
  const date = currentDate.toLocaleString();

  students.forEach(student => {
    db.get(
      'SELECT * FROM attendance WHERE studentId=? AND sessionId=?',
      [student.studentId, sessionId],
      (err, row) => {
        if (!row) {
          db.run(
            'INSERT INTO attendance(studentId, studentName, section, sessionId, timestamp) VALUES(?,?,?,?,?)',
            [student.studentId, student.studentName, section, sessionId, date],
          );
          const io = getIO();
          io.to(sessionId).emit('attendance_update', {
            studentId: student.studentId,
            studentName: student.studentName,
            section,
            sessionId,
            time: currentDate.toLocaleTimeString(),
          });
        }
      },
    );
  });

  res.json({ success: true });
});

export default router;
