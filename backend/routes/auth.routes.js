import express from 'express';
import db from '../utils/test-db.js';

const router = express.Router();

// User login
router.post('/login', (req, res) => {
  const { username, password, role } = req.body;
  db.get(
    `
    SELECT 
    users.id, 
    users.name AS user_name, 
    users.username, 
    users.role, 
    users.password,
    subjects.name AS subject_name
    FROM users
    JOIN faculty
    ON faculty.user_id = users.id
    JOIN subjects
    ON subjects.id = faculty.subject_id
    WHERE users.username = ? AND users.password = ? AND users.role = ?`,
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

      return res.json({
        ok: true,
        name: row.user_name,
        username: row.username,
        subjectName: row.subject_name,
      });
    },
  );
});

export default router;
