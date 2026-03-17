import db from '../utils/db.js';
import utils from '../utils/in-memory-db.js';
import express from 'express';

const router = express.Router();

//Get Counts
router.get('/stats', (req, res) => {
  const stats = {
    students: 0,
    faculty: 0,
    liveSessions: 0,
    attendance: 0,
  };

  db.get(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'student'`,
    (err, studentRow) => {
      stats.students = studentRow.count;

      db.get(
        `SELECT COUNT(*) AS count FROM users WHERE role = 'faculty'`,
        (err, facultyRow) => {
          stats.faculty = facultyRow.count;

          db.get(
            `SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'`,
            (err, sessionRow) => {
              stats.liveSessions = sessionRow.count;

              db.get(
                `SELECT COUNT(*) AS count FROM attendance`,
                (err, attendanceRow) => {
                  stats.attendance = attendanceRow.count;

                  return res.json({
                    ok: true,
                    stats,
                  });
                },
              );
            },
          );
        },
      );
    },
  );
});

export default router;
