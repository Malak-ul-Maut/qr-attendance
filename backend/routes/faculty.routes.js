import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/', (req, res) => {
  db.all(
    `SELECT username, name, password, subjectName, section FROM users WHERE role='faculty'`,
    (err, rows) => {
      return res.json(rows);
    },
  );
});

router.post('/', (req, res) => {
  const { username, name, section, password, subjectName } = req.body;

  db.run(
    `
    INSERT INTO users
    (username, name, password, section, subjectName, role)
    VALUES (?, ?, ?, ?, ?, 'faculty')
  `,
    [username, name, password, section, subjectName],
    () => {
      return res.json({ success: true });
    },
  );
});

router.put('/:username', (req, res) => {
  const { username } = req.params;
  const { name, section, password, subjectName } = req.body;

  db.run(
    `
    UPDATE users
    SET name=?, section=?, password=?, subjectName=?
    WHERE username=?
  `,
    [name, section, password, subjectName, username],
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
