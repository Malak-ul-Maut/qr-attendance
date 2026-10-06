import express from 'express';
import { dbAll, dbGet, dbRun } from '../utils/db.js';
import { todayLocal } from '../utils/dates.js';

const router = express.Router();

// Faculty list. A faculty member no longer has one fixed subject or section: subjectName
// and section list the ones in the timetable rows that are in force today.
router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(
      `
      SELECT
        faculties.username,
        faculties.name,
        faculties.abbr,
        faculties.password_hash AS password,
        (
          SELECT GROUP_CONCAT(DISTINCT subjects.name)
          FROM timetable
          JOIN subjects ON subjects.id = timetable.subject_id
          WHERE timetable.faculty_id = faculties.id
            AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
        ) AS subjectName,
        (
          SELECT GROUP_CONCAT(DISTINCT classes.section)
          FROM timetable
          JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
          JOIN classes ON classes.id = timetable_classes.class_id
          WHERE timetable.faculty_id = faculties.id
            AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
        ) AS section
      FROM faculties
      ORDER BY faculties.name
      `,
      [todayLocal(), todayLocal()],
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.post('/', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const name = String(req.body.name || '').trim();
  const { password } = req.body;

  try {
    if (!username || !name)
      return res.status(400).json({ ok: false, error: 'invalid_faculty_data' });

    // abbr is required by the database. The admin form does not ask for it yet,
    // so one is made from the name unless the request supplies it.
    const abbr = req.body.abbr
      ? String(req.body.abbr).trim()
      : await makeUniqueAbbr(name);

    await dbRun(
      `INSERT INTO faculties (name, abbr, username, password_hash) VALUES (?, ?, ?, ?)`,
      [name, abbr, username, password || 'password'],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return conflictOrError(res, err, 'faculty_conflict');
  }
});

router.put('/:username', async (req, res) => {
  const { username } = req.params;
  const { name, password, abbr } = req.body;
  // subjectName from older versions of the admin form is ignored: subjects now belong
  // to timetable rows, not to the faculty member.

  try {
    const faculty = await dbGet(`SELECT id FROM faculties WHERE username = ?`, [
      username,
    ]);
    if (!faculty) return res.status(404).json({ ok: false, error: 'not_found' });

    await dbRun(
      `UPDATE faculties
       SET name = COALESCE(?, name),
           abbr = COALESCE(?, abbr),
           password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
      [name || null, abbr ? String(abbr).trim() : null, password || null, faculty.id],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return conflictOrError(res, err, 'faculty_conflict');
  }
});

// A faculty member who appears in the timetable (old rows included) cannot be removed,
// because past sessions point at those rows. The faculties table has no "active" flag.
router.delete('/:username', async (req, res) => {
  try {
    const faculty = await dbGet(`SELECT id FROM faculties WHERE username = ?`, [
      req.params.username,
    ]);
    if (!faculty)
      return res.status(404).json({ ok: false, error: 'not_found' });

    const scheduled = await dbGet(
      `SELECT 1 AS found FROM timetable WHERE faculty_id = ? LIMIT 1`,
      [faculty.id],
    );
    if (scheduled)
      return res
        .status(409)
        .json({ ok: false, error: 'faculty_has_timetable' });

    await dbRun(`DELETE FROM faculties WHERE id = ?`, [faculty.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

function conflictOrError(res, err, fallback) {
  if (err.code !== 'SQLITE_CONSTRAINT')
    return res.status(500).json({ ok: false, error: 'database_error' });
  const message = String(err.message);
  if (message.includes('faculties.username'))
    return res.status(409).json({ ok: false, error: 'username_taken' });
  if (message.includes('faculties.abbr'))
    return res.status(409).json({ ok: false, error: 'abbr_taken' });
  return res.status(400).json({ ok: false, error: fallback });
}

// "Mr. Rajat Kumar" -> RK, then RK2, RK3 ... until it is unused.
async function makeUniqueAbbr(name) {
  const letters = name
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\b\.?/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  const base = letters || 'FAC';
  let candidate = base;
  for (let n = 2; await dbGet(`SELECT 1 FROM faculties WHERE abbr = ?`, [candidate]); n++) {
    candidate = `${base}${n}`;
  }
  return candidate;
}

export default router;
