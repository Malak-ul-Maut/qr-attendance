import express from 'express';
import utils from '../utils/in-memory-db.js';
import db from '../utils/db.js';
import { getIO } from '../utils/socket-io.js';

// --------------- Session Routes ----------------
const router = express.Router();
const sessions = {};

// Get slots
router.get('/slots', (req, res) => {
  const { date, faculty_id } = req.query;
  const day = convertToDay(date);

  db.all(
    `
    SELECT DISTINCT
      slots.id,
      slots.label,
      slots.start_time,
      slots.end_time,
      rooms.block,
      rooms.room_number,
      subjects.name AS subject_label,
      subjects.abbr AS subject_abbr
      FROM timetable
    JOIN slots
      ON timetable.slot_id = slots.id
    JOIN rooms
      ON rooms.id = timetable.room_id
    JOIN faculty
      ON faculty.id = timetable.faculty_id
    LEFT JOIN subjects
      ON subjects.id = faculty.subject_id
    JOIN users
      ON users.id = faculty.user_id
    WHERE timetable.day = ?
      AND users.username = ?;
    `,
    [day, faculty_id],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }
      return res.json(rows);
    },
  );
});

// Get students
router.get('/students', (req, res) => {
  const { date, faculty_id } = req.query;
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const day = days[new Date(date).getDay()];

  db.all(
    `
  SELECT 
  students.id,
  students.roll_number,
  students.class_id
  FROM timetable
  JOIN classes on classes.room_id = timetable.room_id
  JOIN students ON students.class_id = classes.id
  WHERE timetable.day = ?
  AND timetable.faculty_id = ?;
  `,
    [day, faculty_id],
    (err, rows) => {
      if (err) console.error(err);
      return res.json(rows);
    },
  );
});

// Get the classes taught by a faculty member in a particular slot.
router.get('/classes', (req, res) => {
  const { date, slotId, faculty_id } = req.query;
  const day = convertToDay(date);

  resolveFacultyId(faculty_id, day, slotId, (facultyErr, facultyId) => {
    if (facultyErr)
      return res.status(500).json({ ok: false, error: 'database_error' });

    db.all(
      `
      SELECT
        timetable.id AS timetable_id,
        classes.id AS class_id,
        courses.abbr AS course,
        branches.abbr AS branch,
        curriculum.semester,
        sections.label AS section
      FROM timetable
      JOIN classes on classes.room_id = timetable.room_id
      JOIN curriculum on curriculum.id = classes.curriculum_id
      JOIN courses ON courses.id = curriculum.course_id
      JOIN branches ON branches.id = curriculum.branch_id
      JOIN sections ON sections.id = classes.section_id
      WHERE timetable.day = ?
        AND timetable.slot_id = ?
        AND timetable.faculty_id = ?
      ORDER BY classes.id;
      `,
      [day, slotId, facultyId],
      (err, rows) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ ok: false, error: 'database_error' });
        }
        return res.json(rows);
      },
    );
  });
});

// Start session.
// QR may cover all timetable rows in the selected slot.
// CCTV must select exactly one class because one camera feed represents one classroom.
router.post('/start', (req, res) => {
  const { date, slotId, facultyId, method = 'qr', classIds } = req.body;
  const day = convertToDay(date);
  const sessionCode = 'sess_' + Math.random().toString(36).slice(2);

  // Dynamic placeholder generation for the array of classIds
  let classFilter = '';
  const params = [day, slotId, facultyId]; // Note: Ensure resolvedFacultyId is defined in your scope

  if (method === 'cctv' && Array.isArray(classIds) && classIds.length > 0) {
    const placeholders = classIds.map(() => '?').join(', ');
    classFilter = `AND EXISTS (
      SELECT 1
      FROM classes selected_class
      WHERE selected_class.room_id = timetable.room_id
        AND selected_class.id IN (${placeholders})
    )`;
    params.push(...classIds);
  }

  db.all(
    `
    SELECT
      timetable.id,
      timetable.room_id,
      MIN(sections.label) AS section
    FROM timetable
    JOIN classes ON classes.room_id = timetable.room_id
    JOIN sections ON sections.id = classes.section_id
    JOIN faculty ON faculty.id = timetable.faculty_id
    JOIN users ON users.id = faculty.user_id
    WHERE timetable.day = ? 
      AND timetable.slot_id = ? 
      AND users.username = ? 
      ${classFilter}
    GROUP BY timetable.id, timetable.room_id
    ORDER BY timetable.id;
    `,
    params,
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'no_timetable_entry' });
      }

      const startTime = new Date().toLocaleTimeString();
      let completed = 0;
      let failed = false;

      rows.forEach(row => {
        db.run(
          `INSERT INTO sessions (session_code, timetable_id, date, start_time) VALUES (?, ?, ?, ?)`,
          [sessionCode, row.id, date, startTime],
          insertErr => {
            if (insertErr && !failed) {
              failed = true;
              console.error(insertErr);
              return res
                .status(500)
                .json({ ok: false, error: 'session_insert_failed' });
            }

            completed++;

            if (completed === rows.length && !failed) {
              const token =
                method === 'qr'
                  ? createSessionToken(sessionCode, 3, rows[0]?.section)
                  : null;

              return res.json({
                ok: true,
                sessionCode,
                method,
                classIds: [...new Set(rows.map(row => row.class_id))], // Returns an array of unique classIds found
                timetableIds: rows.map(row => row.id),
                token,
              });
            }
          },
        );
      });
    },
  );
});

// Issue a fresh token for an existing sessionId
router.post('/token', (req, res) => {
  const { sessionCode } = req.body;

  db.get(
    `
    SELECT sessions.*, sections.label AS section
    FROM sessions
    JOIN timetable ON timetable.id = sessions.timetable_id
    JOIN classes ON classes.room_id = timetable.room_id
    JOIN sections ON sections.id = classes.section_id
    WHERE session_code = ?`,
    [sessionCode],
    (err, row) => {
      if (!row)
        return res.status(400).json({ ok: false, error: 'invalid_session' });

      if (row.end_time !== null)
        return res.status(400).json({ ok: false, error: 'session_ended' });
      let token = createSessionToken(sessionCode, 3, row.section);
      return res.json({ ok: true, token });
    },
  );
});

// Finalize attendance and close every session row belonging to this session code.
router.post('/finalize', (req, res) => {
  const { sessionCode, presentStudentIds } = req.body;

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }
  if (!Array.isArray(presentStudentIds)) {
    return res
      .status(400)
      .json({ ok: false, error: 'invalid_present_student_ids' });
  }

  const checkedStudentIds = [...new Set(presentStudentIds.map(Number))];
  if (checkedStudentIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return res
      .status(400)
      .json({ ok: false, error: 'invalid_present_student_ids' });
  }
  const studentIdPlaceholders = checkedStudentIds.length
    ? checkedStudentIds.map(() => '?').join(', ')
    : 'NULL';

  db.run(
    `
    INSERT INTO attendance (session_id, student_id, status, timestamp)
    SELECT
      sessions.id,
      students.id,
      CASE
        WHEN students.id IN (${studentIdPlaceholders})
          THEN 'present'
        ELSE 'absent'
      END,
      ?
    FROM sessions
    JOIN timetable ON timetable.id = sessions.timetable_id
    JOIN classes ON classes.room_id = timetable.room_id
    JOIN students ON students.class_id = classes.id
    WHERE sessions.session_code = ?
    ON CONFLICT(session_id, student_id) DO UPDATE SET
      status = excluded.status,
      timestamp = excluded.timestamp
    `,
    [...checkedStudentIds, new Date().toLocaleString(), sessionCode],
    err => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }

      db.run(
        `UPDATE sessions SET end_time = ? WHERE session_code = ?`,
        [new Date().toLocaleTimeString(), sessionCode],
        updateErr => {
          if (updateErr) {
            console.error(updateErr);
            return res.status(500).json({ ok: false, error: 'database_error' });
          }

          getIO().to(sessionCode).emit('session_finalized', { sessionCode });
          return res.json({ ok: true, message: 'Finalized' });
        },
      );
    },
  );
});

function resolveFacultyId(value, day, slotId, callback) {
  if (/^\d+$/.test(String(value || ''))) {
    return callback(null, Number(value));
  }

  db.get(
    `
    SELECT faculty.id
    FROM faculty
    JOIN users ON users.id = faculty.user_id
    LEFT JOIN timetable
      ON timetable.faculty_id = faculty.id
      AND timetable.day = ?
      AND timetable.slot_id = ?
    WHERE users.username = ?
    ORDER BY timetable.id IS NULL, timetable.id
    LIMIT 1
    `,
    [day, slotId, value],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(new Error('faculty_not_found'));
      callback(null, row.id);
    },
  );
}

function createSessionToken(sessionCode, expiresInSeconds, section) {
  const token = Math.random().toString(36).slice(2);
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  utils.activeTokens[token] = { sessionCode, section, expiresAt };

  setTimeout(() => delete utils.activeTokens[token], expiresInSeconds * 1000);
  return token;
}

function convertToDay(date) {
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  return days[new Date(date).getDay()];
}

export default router;
