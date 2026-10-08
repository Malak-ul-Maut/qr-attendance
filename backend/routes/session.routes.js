import express from 'express';
import { randomBytes } from 'crypto';
import utils from '../utils/in-memory-db.js';
import { dbAll, dbGet, dbRun, withTransaction } from '../utils/db.js';
import { getIO } from '../utils/socket-io.js';
import { isValidDate, weekdayName } from '../utils/dates.js';
import {
  resolveFacultyId,
  findTimetableRows,
  getSessionRows,
  getSessionSections,
  isSessionEnded,
} from '../utils/timetable.js';

// --------------- Session Routes ----------------
const router = express.Router();

// Get the slots a faculty member teaches on a date (only subjects that take attendance).
router.get('/slots', async (req, res) => {
  const { date, faculty_id } = req.query;
  const day = weekdayName(date);
  if (!day) return res.json([]); // weekend or bad date: nothing is scheduled

  try {
    const rows = await dbAll(
      `
      SELECT DISTINCT
        slots.id,
        slots.label,
        slots.start_time,
        slots.end_time,
        rooms.block,
        rooms.number AS room_number,
        subjects.name AS subject_label,
        subjects.abbr AS subject_abbr
      FROM timetable
      JOIN slots ON slots.id = timetable.slot_id
      JOIN subjects ON subjects.id = timetable.subject_id
      JOIN faculties ON faculties.id = timetable.faculty_id
      LEFT JOIN rooms ON rooms.id = timetable.room_id
      WHERE timetable.day = ?
        AND faculties.username = ?
        AND subjects.takes_attendance = 1
        AND timetable.valid_from <= ?
        AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
      ORDER BY slots.start_time
      `,
      [day, faculty_id, date, date],
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Get the students a faculty member teaches on a date.
router.get('/students', async (req, res) => {
  const { date, faculty_id } = req.query;
  const day = weekdayName(date);
  if (!day) return res.json([]);

  try {
    const rows = await dbAll(
      `
      SELECT DISTINCT
        students.id,
        students.roll_number,
        students_mapping.class_id
      FROM timetable
      JOIN faculties ON faculties.id = timetable.faculty_id
      JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
      JOIN students_mapping
        ON students_mapping.class_id = timetable_classes.class_id
        AND (timetable_classes.batch IS NULL
             OR timetable_classes.batch = students_mapping.batch)
      JOIN students ON students.id = students_mapping.student_id
      WHERE timetable.day = ?
        AND faculties.username = ?
        AND students.active = 1
        AND timetable.valid_from <= ?
        AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
      `,
      [day, faculty_id, date, date],
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Get the classes (and batch) a faculty member teaches in a particular slot.
router.get('/classes', async (req, res) => {
  const { date, slotId, faculty_id } = req.query;
  const day = weekdayName(date);
  if (!day) return res.json([]);

  try {
    const facultyId = await resolveFacultyId(faculty_id);
    if (!facultyId) return res.json([]);

    const rows = await dbAll(
      `
      SELECT
        timetable.id AS timetable_id,
        classes.id AS class_id,
        courses.abbr AS course,
        branches.abbr AS branch,
        classes.semester,
        classes.section,
        timetable_classes.batch
      FROM timetable
      JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
      JOIN classes ON classes.id = timetable_classes.class_id
      JOIN branches ON branches.id = classes.branch_id
      JOIN courses ON courses.id = branches.course_id
      WHERE timetable.day = ?
        AND timetable.slot_id = ?
        AND timetable.faculty_id = ?
        AND timetable.valid_from <= ?
        AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
      ORDER BY classes.id
      `,
      [day, slotId, facultyId, date, date],
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Start session.
// The timetable row decides which classes and batch the session is for, so the body's
// classIds is no longer needed (it is accepted and ignored).
// Starting the same period again on the same day resumes the open session.
router.post('/start', async (req, res) => {
  const { date, slotId, facultyId, method = 'qr' } = req.body;

  if (!isValidDate(date))
    return res.status(400).json({ ok: false, error: 'invalid_date' });
  if (method !== 'qr' && method !== 'cctv')
    return res.status(400).json({ ok: false, error: 'invalid_method' });
  const slot = Number(slotId);
  if (!Number.isInteger(slot))
    return res.status(400).json({ ok: false, error: 'invalid_slot' });

  const day = weekdayName(date);
  if (!day)
    return res.status(404).json({ ok: false, error: 'no_timetable_entry' });

  try {
    const facultyDbId = await resolveFacultyId(facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });

    const rows = await findTimetableRows(facultyDbId, date, day, slot);
    if (rows.length === 0)
      return res.status(404).json({ ok: false, error: 'no_timetable_entry' });

    // The database also blocks this with a trigger; checking first gives a clean error.
    const eligible = rows.filter(row => row.takes_attendance === 1);
    if (eligible.length === 0)
      return res
        .status(400)
        .json({ ok: false, error: 'subject_does_not_take_attendance' });

    const timetableIds = eligible.map(row => row.id);
    const marks = timetableIds.map(() => '?').join(', ');
    const existing = await dbAll(
      `SELECT id, timetable_id, session_code, method, end_time
       FROM sessions WHERE date = ? AND timetable_id IN (${marks})`,
      [date, ...timetableIds],
    );

    if (existing.some(session => session.end_time !== null))
      return res.status(409).json({ ok: false, error: 'session_already_ended' });
    if (existing.some(session => session.method !== method))
      return res
        .status(409)
        .json({ ok: false, error: 'session_method_mismatch' });

    const resumed = existing.length > 0;
    const sessionCode = resumed
      ? existing[0].session_code
      : 'sess_' + randomBytes(6).toString('hex');
    const missing = eligible.filter(
      row => !existing.some(session => session.timetable_id === row.id),
    );

    await withTransaction(async () => {
      for (const row of missing) {
        const session = await dbRun(
          `INSERT INTO sessions (session_code, timetable_id, date, method)
           VALUES (?, ?, ?, ?)`,
          [sessionCode, row.id, date, method],
        );
        // Everyone in the linked class(es)/batch starts as "not marked yet" (= absent).
        await dbRun(
          `
          INSERT INTO attendance (session_id, student_id)
          SELECT DISTINCT ?, students_mapping.student_id
          FROM timetable_classes
          JOIN students_mapping
            ON students_mapping.class_id = timetable_classes.class_id
            AND (timetable_classes.batch IS NULL
                 OR timetable_classes.batch = students_mapping.batch)
          JOIN students
            ON students.id = students_mapping.student_id AND students.active = 1
          WHERE timetable_classes.timetable_id = ?
          `,
          [session.lastID, row.id],
        );
      }

      const total = await dbGet(
        `SELECT COUNT(*) AS count
         FROM attendance
         JOIN sessions ON sessions.id = attendance.session_id
         WHERE sessions.session_code = ?`,
        [sessionCode],
      );
      if (total.count === 0) {
        // Rolls the whole start back: an empty session could not be restarted today.
        throw Object.assign(new Error('class_has_no_students'), {
          status: 400,
        });
      }
    });

    const classRows = await dbAll(
      `SELECT DISTINCT class_id FROM timetable_classes
       WHERE timetable_id IN (${marks}) ORDER BY class_id`,
      timetableIds,
    );

    const response = {
      ok: true,
      sessionCode,
      method,
      classIds: classRows.map(row => row.class_id),
      timetableIds,
      token:
        method === 'qr'
          ? createSessionToken(
              sessionCode,
              TOKEN_LIFETIME_SECONDS,
              await getSessionSections(sessionCode),
            )
          : null,
      resumed,
    };

    if (resumed) {
      // Lets the client show who was already marked before it reconnected.
      const present = await dbAll(
        `SELECT attendance.student_id AS id
         FROM attendance
         JOIN sessions ON sessions.id = attendance.session_id
         WHERE sessions.session_code = ? AND attendance.marked_at IS NOT NULL`,
        [sessionCode],
      );
      response.presentStudentIds = present.map(row => row.id);
    }

    return res.json(response);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ ok: false, error: err.message });
    }
    // Errors raised by the database triggers carry their message.
    if (/does not take attendance/.test(err.message)) {
      return res
        .status(400)
        .json({ ok: false, error: 'subject_does_not_take_attendance' });
    }
    if (/outside the timetable row validity/.test(err.message)) {
      return res.status(400).json({ ok: false, error: 'date_outside_timetable' });
    }
    console.error(err);
    return res.status(500).json({ ok: false, error: 'session_insert_failed' });
  }
});

// Issue a fresh token for an existing session code
router.post('/token', async (req, res) => {
  const { sessionCode } = req.body;

  try {
    const rows = await getSessionRows(sessionCode);
    if (rows.length === 0)
      return res.status(400).json({ ok: false, error: 'invalid_session' });
    if (isSessionEnded(rows))
      return res.status(400).json({ ok: false, error: 'session_ended' });

    const token = createSessionToken(
      sessionCode,
      TOKEN_LIFETIME_SECONDS,
      await getSessionSections(sessionCode),
    );
    return res.json({ ok: true, token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Finalize attendance and close every session row belonging to this session code.
// presentStudentIds is the faculty's final list, so it wins over what was marked live:
//   - listed but not marked yet   -> present, method 'manual'
//   - marked but not listed       -> back to absent (the faculty removed them)
router.post('/finalize', async (req, res) => {
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

  try {
    const rows = await getSessionRows(sessionCode);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }

    const sessionIds = `SELECT id FROM sessions WHERE session_code = ?`;
    const marks = checkedStudentIds.map(() => '?').join(', ');

    await withTransaction(async () => {
      // Marked, but the faculty took them off the list: absent again.
      await dbRun(
        `
        UPDATE attendance
        SET marked_at = NULL, method = NULL, camera_fingerprint = NULL
        WHERE session_id IN (${sessionIds})
          AND marked_at IS NOT NULL
          ${checkedStudentIds.length ? `AND student_id NOT IN (${marks})` : ''}
        `,
        [sessionCode, ...checkedStudentIds],
      );

      // On the list but not marked yet: the faculty added them by hand.
      if (checkedStudentIds.length) {
        await dbRun(
          `
          UPDATE attendance
          SET marked_at = datetime('now'), method = 'manual'
          WHERE session_id IN (${sessionIds})
            AND marked_at IS NULL
            AND student_id IN (${marks})
          `,
          [sessionCode, ...checkedStudentIds],
        );
      }

      // Keep the first end time if this is a retry.
      await dbRun(
        `UPDATE sessions SET end_time = datetime('now')
         WHERE session_code = ? AND end_time IS NULL`,
        [sessionCode],
      );
    });

    getIO().to(sessionCode).emit('session_finalized', { sessionCode });
    return res.json({ ok: true, message: 'Finalized' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Checked when the request reaches the server, so it must cover slow campus Wi-Fi.
// The QR still rotates every few seconds, so a screenshot is useless.
const TOKEN_LIFETIME_SECONDS = 8;

function createSessionToken(sessionCode, expiresInSeconds, section) {
  const token = randomBytes(12).toString('hex');
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  utils.activeTokens[token] = { sessionCode, section, expiresAt };

  setTimeout(() => delete utils.activeTokens[token], expiresInSeconds * 1000);
  return token;
}

export default router;
