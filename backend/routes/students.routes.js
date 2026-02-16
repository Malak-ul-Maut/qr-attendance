import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

// User login
router.post('/enroll', (req, res) => {
  const data = req.body;

  data.forEach(({ label, descriptors }) => {
    db.run(
      `
    UPDATE users SET faceDescriptors = ? WHERE username = ?`,
      [JSON.stringify(descriptors), label],
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
