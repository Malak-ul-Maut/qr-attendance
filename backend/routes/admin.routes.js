import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

//Get Counts
router.get('/stats', (req, res) => {
  const stats = {
    students: 0,
    faculty: 0,
    liveSessions: 0,
  };

  db.get(`SELECT COUNT(*) AS count FROM users WHERE role = 'student'`, (err, studentRow) => {
    if (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }

    stats.students = studentRow.count;

    db.get(`SELECT COUNT(*) AS count FROM users WHERE role = 'faculty'`, (err, facultyRow) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }

      stats.faculty = facultyRow.count;

      db.get(`SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'`, (err, sessionRow) => {
        if (err) {
          return res.status(500).json({ ok: false, error: err.message });
        }

        stats.liveSessions = sessionRow.count;

        return res.json({
          ok: true,
          stats,
        });
      });
    });
  });
});

//Get Students
router.get('/students', (req, res) => {
  db.all(
    `SELECT name, username, section
     FROM users
     WHERE role = 'student'
     ORDER BY name ASC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }

      return res.json({
        ok: true,
        students: rows,
      });
    }
  );
});

///Get Faculty
router.get('/faculty', (req, res) => {
  db.all(
    `SELECT name, username, subjectName
     FROM users
     WHERE role = 'faculty'
     ORDER BY name ASC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }

      return res.json({
        ok: true,
        faculty: rows,
      });
    }
  );
});

//Add Students
router.post('/add-student', (req, res) => {
  const { name, username, password, section } = req.body;

  if (!name || !username || !password || !section) {
    return res.status(400).json({
      ok: false,
      error: 'All student fields are required',
    });
  }

  db.run(
    `INSERT INTO users (name, username, password, role, section)
     VALUES (?, ?, ?, 'student', ?)`,
    [name, username, password, section],
    function (err) {
      if (err) {
        return res.status(500).json({
          ok: false,
          error: err.message,
        });
      }

      return res.json({
        ok: true,
        message: 'Student added successfully',
      });
    }
  );
});

//Add Faculty
router.post('/add-faculty', (req, res) => {
  const { name, username, password, subjectName } = req.body;

  if (!name || !username || !password || !subjectName) {
    return res.status(400).json({
      ok: false,
      error: 'All faculty fields are required',
    });
  }

  db.run(
    `INSERT INTO users (name, username, password, role, subjectName)
     VALUES (?, ?, ?, 'faculty', ?)`,
    [name, username, password, subjectName],
    function (err) {
      if (err) {
        return res.status(500).json({
          ok: false,
          error: err.message,
        });
      }

      return res.json({
        ok: true,
        message: 'Faculty added successfully',
        });
    }
  );
});
export default router;