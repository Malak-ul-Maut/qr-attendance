import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/stats', (req, res) => {
  db.get(
    `
    SELECT
      (SELECT COUNT(*) FROM students) AS students,
      (SELECT COUNT(DISTINCT user_id) FROM faculty) AS faculty,
      (SELECT COUNT(*) FROM sessions WHERE end_time IS NULL) AS liveSessions,
      (SELECT COUNT(*) FROM attendance) AS attendance
    `,
    (err, stats) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }

      return res.json({ ok: true, stats });
    },
  );
});

export default router;
