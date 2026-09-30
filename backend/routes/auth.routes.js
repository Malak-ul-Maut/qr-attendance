import express from 'express';
import db from '../utils/db.js';
import testDb from '../utils/test-db.js';

const router = express.Router();

// User login
router.post('/login', (req, res) => {
  const { username, password, role } = req.body;
  const sendUser = row => {
    if (!row || row.password !== password || row.role !== role)
      return res.status(401).json({
        ok: false,
        error: 'invallid_credentials',
      });

    return res.json({
      ok: true,
      name: row.user_name,
      username: row.username,
      role: row.role,
      subjectName: row.subject_name,
      section: row.section,
    });
  };

  db.get(
    `SELECT name AS user_name, username, role, password,
            subjectName AS subject_name, section
     FROM users WHERE username = ?`,
    [username],
    (err, row) => {
      if (err) {
        console.error('DB error:', err);
        return res.status(500).json({
          ok: false,
          error: 'database_error',
        });
      }
      if (row) return sendUser(row);

      testDb.get(
        `SELECT users.name AS user_name, users.username, users.role,
                users.password, subjects.name AS subject_name,
                NULL AS section
         FROM users
         LEFT JOIN faculty ON faculty.user_id = users.id
         LEFT JOIN subjects ON subjects.id = faculty.subject_id
         WHERE users.username = ?`,
        [username],
        (testDbError, testRow) => {
          if (testDbError) {
            console.error('Test DB error:', testDbError);
            return res.status(500).json({
              ok: false,
              error: 'database_error',
            });
          }

          return sendUser(testRow);
        },
      );
    },
  );
});

export default router;
