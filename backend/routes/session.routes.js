import express from 'express';
import utils from '../utils/in-memory-db.js';
import db from '../utils/db.js';
import { getIO } from '../utils/socket-io.js';

// --------------- Session Routes ----------------
const router = express.Router();
const sessions = {};

// What a refresh needs to put the teacher back where they were: how the session
// was started, and the roster as the teacher last saw it. Manual additions, CCTV
// results and "mark absent" changes live only in the browser until this saves them.
db.run(`
  CREATE TABLE IF NOT EXISTS session_drafts (
    session_code TEXT PRIMARY KEY,
    method TEXT NOT NULL DEFAULT 'qr',
    roster TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT
  )
`);

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

              // Remember how this session was started so a refresh can resume it
              return db.run(
                `INSERT OR REPLACE INTO session_drafts (session_code, method, roster, updated_at) VALUES (?, ?, '{}', ?)`,
                [
                  sessionCode,
                  method === 'cctv' ? 'cctv' : 'qr',
                  new Date().toISOString(),
                ],
                draftErr => {
                  if (draftErr) console.error(draftErr);
                  return res.json({
                    ok: true,
                    sessionCode,
                    method,
                    classIds: [...new Set(rows.map(row => row.class_id))], // Returns an array of unique classIds found
                    timetableIds: rows.map(row => row.id),
                    token,
                  });
                },
              );
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

          // The session is closed, so its saved draft is no longer needed.
          // Answer only once it is gone, so nothing can resume a finished session.
          db.run(
            `DELETE FROM session_drafts WHERE session_code = ?`,
            [sessionCode],
            draftErr => {
              if (draftErr) console.error(draftErr);
              getIO()
                .to(sessionCode)
                .emit('session_finalized', { sessionCode });
              return res.json({ ok: true, message: 'Finalized' });
            },
          );
        },
      );
    },
  );
});

// ---------- Resume, discard and clean up ----------
// A faculty member's own unfinished sessions. Everything below only ever touches
// sessions that belong to the given faculty username and have no end_time yet.
const OPEN_SESSIONS = `
  FROM sessions
  JOIN timetable ON timetable.id = sessions.timetable_id
  JOIN slots ON slots.id = timetable.slot_id
  JOIN faculty ON faculty.id = timetable.faculty_id
  JOIN users ON users.id = faculty.user_id
  LEFT JOIN session_drafts ON session_drafts.session_code = sessions.session_code
  WHERE users.username = ?
    AND sessions.end_time IS NULL`;

// List unfinished sessions, newest first
router.get('/active', async (req, res) => {
  const { faculty_id } = req.query;
  if (!faculty_id)
    return res.status(400).json({ ok: false, error: 'missing_faculty' });

  try {
    const rows = await dbAll(
      `
      SELECT
        sessions.session_code AS sessionCode,
        MIN(sessions.date) AS date,
        MIN(sessions.start_time) AS startedAt,
        slots.id AS slotId,
        slots.label AS slotLabel,
        COALESCE(session_drafts.method, 'qr') AS method,
        (
          SELECT COUNT(*)
          FROM attendance
          JOIN sessions scanned ON scanned.id = attendance.session_id
          WHERE scanned.session_code = sessions.session_code
        ) AS scanCount
      ${OPEN_SESSIONS}
      GROUP BY sessions.session_code, slots.id, session_drafts.method
      ORDER BY MAX(sessions.id) DESC
      LIMIT 200
      `,
      [faculty_id],
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Everything needed to rebuild the live screen: the saved roster plus every scan
// the server recorded (some may have arrived after the last save).
router.get('/resume', async (req, res) => {
  const { sessionCode, faculty_id } = req.query;

  try {
    const session =
      sessionCode && faculty_id
        ? await findOpenSession(sessionCode, faculty_id)
        : null;
    if (!session)
      return res.status(404).json({ ok: false, error: 'session_not_found' });

    const draft = await dbGet(
      `SELECT method, roster FROM session_drafts WHERE session_code = ?`,
      [sessionCode],
    );
    let roster = {};
    try {
      roster = JSON.parse(draft?.roster || '{}');
    } catch {
      // A damaged draft is not fatal: the scans below still rebuild most of it
    }

    const scans = await dbAll(
      `
      SELECT attendance.student_id AS id, users.name, attendance.timestamp
      FROM attendance
      JOIN sessions ON sessions.id = attendance.session_id
      JOIN students ON students.id = attendance.student_id
      JOIN users ON users.id = students.user_id
      WHERE sessions.session_code = ?
        AND attendance.status = 'present'
      `,
      [sessionCode],
    );

    return res.json({
      ok: true,
      sessionCode,
      date: session.date,
      slotId: session.slotId,
      slotLabel: session.slotLabel,
      method: draft?.method === 'cctv' ? 'cctv' : 'qr',
      roster,
      scans,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Save the roster as the teacher currently sees it
router.post('/draft', async (req, res) => {
  const { sessionCode, facultyId, method, roster } = req.body || {};
  if (
    !sessionCode ||
    !roster ||
    typeof roster !== 'object' ||
    Array.isArray(roster)
  )
    return res.status(400).json({ ok: false, error: 'invalid_roster' });

  try {
    if (!(await findOpenSession(sessionCode, facultyId)))
      return res.status(404).json({ ok: false, error: 'session_not_found' });

    await dbRun(
      `
      INSERT INTO session_drafts (session_code, method, roster, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_code) DO UPDATE SET
        method = excluded.method,
        roster = excluded.roster,
        updated_at = excluded.updated_at
      `,
      [
        sessionCode,
        method === 'cctv' ? 'cctv' : 'qr',
        JSON.stringify(cleanRoster(roster)),
        new Date().toISOString(),
      ],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Throw away a session that was started by mistake. Only open sessions can go,
// so submitted attendance is never touched.
router.post('/cancel', async (req, res) => {
  const { sessionCode, facultyId } = req.body || {};

  try {
    if (
      !sessionCode ||
      !facultyId ||
      !(await findOpenSession(sessionCode, facultyId))
    )
      return res.status(404).json({ ok: false, error: 'session_not_found' });

    await dbRun(
      `DELETE FROM attendance WHERE session_id IN (
         SELECT id FROM sessions WHERE session_code = ? AND end_time IS NULL
       )`,
      [sessionCode],
    );
    await dbRun(
      `DELETE FROM sessions WHERE session_code = ? AND end_time IS NULL`,
      [sessionCode],
    );
    await dbRun(`DELETE FROM session_drafts WHERE session_code = ?`, [
      sessionCode,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Remove old unfinished sessions that never recorded a single scan. Nothing was
// ever recorded in them, so nothing is lost. Sessions with any attendance stay.
router.post('/cleanup', async (req, res) => {
  const { facultyId, before } = req.body || {};
  if (!facultyId || !/^\d{4}-\d{2}-\d{2}$/.test(String(before)))
    return res.status(400).json({ ok: false, error: 'invalid_request' });

  const EMPTY_OLD = `
    sessions.end_time IS NULL
    AND sessions.date < ?
    AND sessions.timetable_id IN (
      SELECT timetable.id
      FROM timetable
      JOIN faculty ON faculty.id = timetable.faculty_id
      JOIN users ON users.id = faculty.user_id
      WHERE users.username = ?
    )
    AND NOT EXISTS (
      SELECT 1
      FROM attendance
      JOIN sessions scanned ON scanned.id = attendance.session_id
      WHERE scanned.session_code = sessions.session_code
    )`;

  try {
    const { removed } = await dbGet(
      `SELECT COUNT(DISTINCT sessions.session_code) AS removed FROM sessions WHERE ${EMPTY_OLD}`,
      [before, facultyId],
    );
    await dbRun(`DELETE FROM sessions WHERE ${EMPTY_OLD}`, [before, facultyId]);
    await dbRun(
      `DELETE FROM session_drafts WHERE session_code NOT IN (SELECT session_code FROM sessions)`,
    );
    return res.json({ ok: true, removed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Is this session still open, and does it belong to this faculty member?
function findOpenSession(sessionCode, username) {
  return dbGet(
    `
    SELECT sessions.id, sessions.date, slots.id AS slotId, slots.label AS slotLabel
    ${OPEN_SESSIONS}
      AND sessions.session_code = ?
    LIMIT 1
    `,
    [username, sessionCode],
  );
}

// The browser sends this, so keep only what the roster is supposed to contain
function cleanRoster(roster) {
  const clean = {};
  for (const [id, s] of Object.entries(roster).slice(0, 2000)) {
    if (!/^\d+$/.test(id) || !s || typeof s !== 'object') continue;
    clean[id] = {
      name: String(s.name || '').slice(0, 100),
      time: String(s.time || '').slice(0, 20),
      source: ['qr', 'cctv', 'manual'].includes(s.source) ? s.source : 'manual',
      present: s.present === true,
    };
  }
  return clean;
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
