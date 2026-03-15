import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/', (req, res) => {
  db.all(
    `SELECT username, name, section FROM users WHERE role='student'`,
    (err, rows) => {
      return res.json(rows);
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
  const { studentId, name, section } = req.body;

  db.run(
    `
    INSERT INTO users
    (username, name, section, role)
    VALUES (?, ?, ?, 'student')
  `,
    [studentId, name, section],
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

// User login
router.post('/enroll', (req, res) => {
  const data = req.body;

  data.forEach(({ label, descriptor }) => {
    db.run(
      `
    UPDATE users SET faceDescriptors = ? WHERE username = ?`,
      [JSON.stringify(descriptor), label],
    );
  });

  return res.json({ ok: true });
});

router.get('/descriptors', (req, res) => {
  const id = req.query.id;
  db.get(
    `SELECT faceDescriptors FROM users WHERE username = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ ok: false, error: err });
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json(row.faceDescriptors);
    },
  );
});

export default router;
