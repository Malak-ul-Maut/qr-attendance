const db = require('../db');
const utils = require('../utils');
const express = require('express');
const router = express.Router();

// Verify student scan
router.post('/verify', (req, res) => {
  const { studentId, studentName, token, cameraFingerprint } = req.body;

  if (!utils.activeTokens[token])
    return res
      .status(400)
      .json({ ok: false, error: 'invalid_or_expired_token' });
  const { sessionId, section } = utils.activeTokens[token];

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
            sessionId,
          });
        },
      );
    },
  );
});

module.exports = router;
