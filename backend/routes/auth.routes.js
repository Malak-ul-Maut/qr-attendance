import express from 'express';
import { dbGet } from '../utils/db.js';
import { issueAdminToken } from '../utils/admin-auth.js';
import { todayLocal } from '../utils/dates.js';

const router = express.Router();

// Login. There is one table per role, so the role decides which table is checked.
// password_hash is still compared as plain text (hashing comes later).
router.post('/login', async (req, res) => {
  const { username, password, role } = req.body;

  try {
    let account = null;

    if (role === 'admin') {
      account = await dbGet(
        `SELECT name, username FROM admins WHERE username = ? AND password_hash = ?`,
        [username, password],
      );
    } else if (role === 'faculty') {
      account = await dbGet(
        `
        SELECT faculties.id, faculties.name, faculties.username
        FROM faculties
        WHERE faculties.username = ? AND faculties.password_hash = ? AND faculties.active = 1
        `,
        [username, password],
      );
      if (account) account.subjectName = await currentSubjects(account.id);
    } else if (role === 'student') {
      // Inactive (soft-deleted) students cannot log in.
      account = await dbGet(
        `SELECT name, username FROM students
         WHERE username = ? AND password_hash = ? AND active = 1`,
        [username, password],
      );
    }

    if (!account) {
      return res.status(401).json({ ok: false, error: 'invallid_credentials' });
    }

    const result = {
      ok: true,
      role,
      name: account.name,
      username: account.username,
      // A faculty member no longer has one subject: this lists the subjects of the
      // timetable rows that are in force (empty for admins and students).
      subjectName: account.subjectName ?? null,
    };
    if (role === 'admin') result.adminToken = issueAdminToken(account.username);
    return res.json(result);
  } catch (err) {
    console.error('DB error:', err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

async function currentSubjects(facultyId) {
  const row = await dbGet(
    `
    SELECT GROUP_CONCAT(name, ', ') AS names FROM (
      SELECT DISTINCT subjects.name
      FROM timetable
      JOIN subjects ON subjects.id = timetable.subject_id
      WHERE timetable.faculty_id = ?
        AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
      ORDER BY subjects.name
    )
    `,
    [facultyId, todayLocal()],
  );
  return row?.names ?? null;
}

export default router;
