import express from 'express';
import utils from '../utils/in-memory-db.js';
import db from '../utils/db.js';

// --------------- Session Routes ----------------
const router = express.Router();
const sessions = {};

// Start session
router.post('/start', (req, res) => {
  const { section, teacherId, year, semester } = req.body;
  const sessionId = 'sess_' + Math.random().toString(36).slice(2);
  sessions[sessionId] = { section, teacherId, year, semester, active: true };

  db.run(
    `INSERT OR REPLACE INTO sessions (sessionId, section, teacherId, year, semester, status) VALUES (?, ?, ?, 'active')`,
    [sessionId, section, teacherId, year, semester],
  );

  let token = createSessionToken(sessionId, section, 3);
  return res.json({ ok: true, sessionId, token });
});

// Issue a fresh token for an existing sessionId
router.post('/token', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !sessions[sessionId])
    return res.status(400).json({ ok: false, error: 'invalid' });

  const { section } = sessions[sessionId];
  let token = createSessionToken(sessionId, section, 3);
  return res.json({ ok: true, token });
});

// Finalize attendance
router.post('/finalize', (req, res) => {
  const { sessionId, keepStudentIds } = req.body;
  sessions[sessionId].active = false;
  const placeholders = keepStudentIds.map(() => '?').join(','); // '?,?,?,?,....,?'

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

  db.run(
    `UPDATE sessions SET endTime = datetime('now'), status = 'ended' WHERE sessionId = ?`,
    [sessionId],
  );
});

function createSessionToken(sessionId, section, expiresInSeconds) {
  const token = Math.random().toString(36).slice(2);
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  utils.activeTokens[token] = { sessionId, section, expiresAt };

  setTimeout(() => delete utils.activeTokens[token], expiresInSeconds * 1000);
  return token;
}

export default router;
