import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT users.username, users.name, users.password,
        GROUP_CONCAT(DISTINCT subjects.name) AS subjectName,
        GROUP_CONCAT(DISTINCT sections.label) AS section
      FROM users
      JOIN faculty ON faculty.user_id = users.id
      JOIN subjects ON subjects.id = faculty.subject_id
      LEFT JOIN timetable ON timetable.faculty_id = faculty.id
      LEFT JOIN classes ON classes.room_id = timetable.room_id
      LEFT JOIN sections ON sections.id = classes.section_id
      WHERE users.role = 'faculty'
      GROUP BY users.id
      ORDER BY users.name
    `);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.post('/', async (req, res) => {
  const { username, name, password, subjectName } = req.body;

  try {
    const subject = await resolveSubject(subjectName);
    if (!username || !name || !subject)
      return res.status(400).json({ ok: false, error: 'invalid_faculty_data' });

    const user = await dbRun(
      `INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, 'faculty')`,
      [username, name, password || 'password'],
    );
    await dbRun(`INSERT INTO faculty (user_id, subject_id) VALUES (?, ?)`, [
      user.lastID,
      subject.id,
    ]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(err.code === 'SQLITE_CONSTRAINT' ? 400 : 500).json({
      ok: false,
      error:
        err.code === 'SQLITE_CONSTRAINT'
          ? 'faculty_conflict'
          : 'database_error',
    });
  }
});

router.put('/:username', async (req, res) => {
  const { username } = req.params;
  const { name, password, subjectName } = req.body;

  try {
    const user = await dbGet(
      `SELECT id FROM users WHERE username = ? AND role = 'faculty'`,
      [username],
    );
    if (!user) return res.status(404).json({ ok: false, error: 'not_found' });

    const subject = await resolveSubject(subjectName);
    if (!subject)
      return res.status(400).json({ ok: false, error: 'invalid_subject' });

    await dbRun(
      `UPDATE users SET name = COALESCE(?, name), password = COALESCE(?, password) WHERE id = ?`,
      [name || null, password || null, user.id],
    );
    await dbRun(
      `INSERT OR IGNORE INTO faculty (user_id, subject_id) VALUES (?, ?)`,
      [user.id, subject.id],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.delete('/:studentId', async (req, res) => {
  try {
    const faculty = await dbGet(
      `SELECT users.id AS user_id FROM users WHERE users.username = ? AND users.role = 'faculty'`,
      [req.params.studentId],
    );
    if (!faculty)
      return res.status(404).json({ ok: false, error: 'not_found' });

    const scheduled = await dbGet(
      `SELECT 1 AS found FROM faculty JOIN timetable ON timetable.faculty_id = faculty.id WHERE faculty.user_id = ? LIMIT 1`,
      [faculty.user_id],
    );
    if (scheduled)
      return res
        .status(409)
        .json({ ok: false, error: 'faculty_has_timetable' });

    await dbRun(`DELETE FROM faculty WHERE user_id = ?`, [faculty.user_id]);
    await dbRun(`DELETE FROM users WHERE id = ?`, [faculty.user_id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

function resolveSubject(subjectName) {
  if (!subjectName) return Promise.resolve(null);
  return dbGet(
    `SELECT id FROM subjects WHERE name = ? OR abbr = ? OR subject_code = ? ORDER BY id LIMIT 1`,
    [subjectName, subjectName, subjectName],
  );
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

export default router;
