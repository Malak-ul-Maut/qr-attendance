import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/', (req, res) => {
  db.all(
    `SELECT username, name, section, password FROM users WHERE role='student'`,
    (err, rows) => {
      return res.json(rows);
    },
  );
});

router.get('/descriptors', (req, res) => {
  const id = req.query.id;

  db.get(
    `SELECT faceDescriptors FROM users WHERE username = ?`,
    [id],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json(JSON.parse(row.faceDescriptors));
    },
  );
});

router.get('/:section', (req, res) => {
  const section = req.params.section;
  db.all(
    'SELECT username, name FROM users WHERE role="student" AND section=?',
    [section],
    (err, rows) => {
      res.json(rows);
    },
  );
});

router.post('/', (req, res) => {
  const { username, name, section, password, faceDescriptor } = req.body;

  db.run(
    `
    INSERT INTO users
    (username, name, section, password, faceDescriptor, role)
    VALUES (?, ?, ?, ?, ?, 'student')
  `,
    [username, name, section, password, faceDescriptor],
    () => {
      return res.json({ success: true });
    },
  );
});

router.put('/:username', (req, res) => {
  const { username } = req.params;
  const { name, section, password, faceDescriptor } = req.body;

  db.run(
    `
    UPDATE users
    SET name=?, section=?, password=?, faceDescriptor=?
    WHERE username=?
  `,
    [name, section, password, faceDescriptor, username],
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
