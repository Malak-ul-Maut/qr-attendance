import db from '../utils/db.js';
import utils from '../utils/in-memory-db.js';
import express from 'express';

const router = express.Router();

// Verify student scan
router.post('/verify', (req, res) => {
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

    sessionId = tokenData.sessionId;
    section = tokenData.section;

    return res.json({ ok: true, sessionId, section });
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
        `INSERT INTO attendance (studentid, studentName, section, sessionId, cameraFingerprint) VALUES (?, ?, ?, ?, ?)`,
        [studentId, studentName, section, sessionId, cameraFingerprint],
        () => {
          utils.teacherSockets.forEach(sock =>
            sock.emit('attendance_update', {
              studentId,
              studentName,
              section,
              sessionId,
              time: new Date().toLocaleTimeString(),
            }),
          );
          return res.json({
            ok: true,
            message: 'Attendance recorded',
          });
        },
      );
    },
  );
});

export default router;
