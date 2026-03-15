import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/', (req, res) => {
  db.all(
    `SELECT username, name, section FROM users WHERE role='faculty'`,
    (err, rows) => {
      return res.json(rows);
    },
  );
});

router.post('/', (req, res) => {
  const { username, name, section } = req.body;

  db.run(
    `
    INSERT INTO users
    (username, name, section, role)
    VALUES (?, ?, ?, 'faculty')
  `,
    [username, name, section],
    () => {
      return res.json({ success: true });
    },
  );
});

router.delete('/:studentId', (req, res) => {
  const username = req.params.studentId;
  db.run(`DELETE FROM users WHERE username = ?`, [username], () => {
    return res.json({ success: true });
  });
});

export default router;
