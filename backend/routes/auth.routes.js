import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

// User login
router.post('/login', (req, res) => {
  const { username, password, role } = req.body;
  db.get(
    `SELECT * FROM users WHERE username = ? AND password = ? AND role = ?`,
    [username, password, role],
    (err, row) => {
      if (err) {
        console.error('DB error:', err);
        return res.status(500).json({
          ok: false,
          error: 'database_error',
        });
      }
      if (!row)
        return res.status(401).json({
          ok: false,
          error: 'invallid_credentials',
        });
      const { name, username, subjectName } = row;

      return res.json({ ok: true, name, username, subjectName });
    },
  );
});

export default router;
