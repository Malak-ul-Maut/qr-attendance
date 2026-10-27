import express from 'express';
import { randomBytes } from 'crypto';
import utils from '../utils/in-memory-db.js';
import { dbAll, dbGet, dbRun, withTransaction } from '../utils/db.js';
import { getIO, notifyClasses } from '../utils/socket-io.js';
import {
  warmSessionCamera,
  releaseSessionCamera,
  growGalleryFromSession,
} from './cctv.routes.js';
import { isValidDate, weekdayName, classDayName } from '../utils/dates.js';
import {
  resolveFacultyId,
  findTimetableRows,
  getSessionRows,
  getSessionSections,
  getSessionHeader,
  findSlotHolder,
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
        timetable.room_id,
        (rooms.camera_url IS NOT NULL AND TRIM(rooms.camera_url) <> '') AS has_camera,
        subjects.name AS subject_label,
        subjects.abbr AS subject_abbr,
        -- Someone else already holds this period for the same class(es): it was borrowed from this faculty,
        -- or the class was merged into another faculty's session.
        (SELECT other_faculty.name
           FROM sessions
           JOIN session_classes ON session_classes.session_id = sessions.id
           JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
             AND timetable_classes.class_id = session_classes.class_id
             AND (timetable_classes.batch IS NULL OR session_classes.batch IS NULL
                  OR timetable_classes.batch = session_classes.batch)
           LEFT JOIN faculties other_faculty ON other_faculty.id = sessions.faculty_id
          WHERE sessions.date = ? AND sessions.slot_id = timetable.slot_id
            AND (sessions.faculty_id IS NULL OR sessions.faculty_id <> timetable.faculty_id)
          LIMIT 1) AS taken_by
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
      [date, day, faculty_id, date, date],
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

// ---------------------------------------------------------------------------
// Starting sessions
//
// The timetable is the PLAN; a session is what really happened. A session says who took the period,
// what subject, in which room, and which classes were in it. One rule keeps everyone honest: a class
// (or batch) can be in only ONE session per date and period (a database trigger on session_classes).
// So when a faculty borrows a period, the lender can no longer start it; when a class is merged into
// someone's session, its own faculty can no longer start it; and nobody can double-mark a class.
// ---------------------------------------------------------------------------
const SLOT_CLASH = /already has a session in this period/;

function fail(status, error, extra = {}) {
  return Object.assign(new Error(error), { status, extra });
}

const uniqueIds = value =>
  [...new Set((Array.isArray(value) ? value : []).map(Number))].filter(
    id => Number.isSafeInteger(id) && id > 0,
  );

async function roomBusy(roomId, date, slotId, sessionCode) {
  if (!roomId) return null;
  const row = await dbGet(
    `SELECT faculties.name AS name FROM sessions
     LEFT JOIN faculties ON faculties.id = sessions.faculty_id
     WHERE sessions.room_id = ? AND sessions.date = ? AND sessions.slot_id = ?
       AND sessions.session_code <> ? AND sessions.end_time IS NULL
     LIMIT 1`,
    [roomId, date, slotId, sessionCode],
  );
  return row ? row.name || 'another faculty' : null;
}

// targets: [{ timetableId|null, slotId, subjectId, roomId|null, kind, classes: [{ class_id, batch }] }]
// All targets share one session code (one QR, one submit), e.g. a double lecture.
async function startSessions({ date, facultyDbId, method, targets }) {
  // Sessions already open for these periods (the faculty is resuming after a reload).
  for (const target of targets) {
    const classMarks = target.classes.map(() => '?').join(', ');
    target.existing = target.timetableId
      ? await dbGet(
          `SELECT sessions.id, sessions.session_code, sessions.method, sessions.end_time,
                  sessions.faculty_id, faculties.name AS faculty_name
           FROM sessions LEFT JOIN faculties ON faculties.id = sessions.faculty_id
           WHERE sessions.timetable_id = ? AND sessions.date = ?`,
          [target.timetableId, date],
        )
      : await dbGet(
          `SELECT sessions.id, sessions.session_code, sessions.method, sessions.end_time,
                  sessions.faculty_id, faculties.name AS faculty_name
           FROM sessions LEFT JOIN faculties ON faculties.id = sessions.faculty_id
           WHERE sessions.timetable_id IS NULL AND sessions.date = ? AND sessions.slot_id = ?
             AND EXISTS (SELECT 1 FROM session_classes
                          WHERE session_classes.session_id = sessions.id
                            AND session_classes.class_id IN (${classMarks}))`,
          [date, target.slotId, ...target.classes.map(c => c.class_id)],
        );
  }
  const existing = targets.map(target => target.existing).filter(Boolean);

  const other = existing.find(row => row.faculty_id !== facultyDbId);
  if (other)
    throw fail(409, 'slot_taken', {
      takenBy: other.faculty_name || 'another faculty',
    });
  if (existing.some(row => row.end_time !== null))
    throw fail(409, 'session_already_ended');
  if (existing.some(row => row.method !== method))
    throw fail(409, 'session_method_mismatch');

  const resumed = existing.length > 0;
  const sessionCode = resumed
    ? existing[0].session_code
    : 'sess_' + randomBytes(6).toString('hex');
  const missing = targets.filter(target => !target.existing);

  // Nobody else may be using the room in that period.
  for (const target of missing) {
    const busyBy = await roomBusy(
      target.roomId,
      date,
      target.slotId,
      sessionCode,
    );
    if (busyBy) throw fail(409, 'room_in_use', { takenBy: busyBy });
  }

  try {
    await withTransaction(async () => {
      for (const [index, target] of missing.entries()) {
        const session = await dbRun(
          `INSERT INTO sessions (session_code, timetable_id, date, method, slot_id, subject_id, faculty_id, room_id, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionCode,
            target.timetableId,
            date,
            method,
            target.slotId,
            target.subjectId,
            facultyDbId,
            target.roomId,
            target.kind,
          ],
        );
        for (const cls of target.classes) {
          await dbRun(
            `INSERT INTO session_classes (session_id, class_id, batch, merged) VALUES (?, ?, ?, 0)`,
            [session.lastID, cls.class_id, cls.batch ?? null],
          );
        }
        // Everyone in the covered class(es)/batch starts as "not marked yet" (= absent).
        await dbRun(
          `
          INSERT INTO attendance (session_id, student_id)
          SELECT DISTINCT ?, students_mapping.student_id
          FROM session_classes
          JOIN students_mapping
            ON students_mapping.class_id = session_classes.class_id
            AND (session_classes.batch IS NULL OR session_classes.batch = students_mapping.batch)
          JOIN students
            ON students.id = students_mapping.student_id AND students.active = 1
          WHERE session_classes.session_id = ?
          `,
          [session.lastID, session.lastID],
        );
      }

      const total = await dbGet(
        `SELECT COUNT(*) AS count
         FROM attendance
         JOIN sessions ON sessions.id = attendance.session_id
         WHERE sessions.session_code = ?`,
        [sessionCode],
      );
      if (total.count === 0) throw fail(400, 'class_has_no_students'); // rolls the whole start back
    });
  } catch (err) {
    if (SLOT_CLASH.test(err.message)) {
      // Say who holds the period instead of a bare error.
      for (const target of missing) {
        const ids = target.classes.map(c => c.class_id);
        const holder = await findSlotHolder(
          date,
          target.slotId,
          ids,
          facultyDbId,
        );
        if (holder) throw fail(409, 'slot_taken', { takenBy: holder.name });
      }
      throw fail(409, 'slot_taken', { takenBy: 'another faculty' });
    }
    throw err;
  }

  const classRows = await dbAll(
    `SELECT DISTINCT session_classes.class_id FROM session_classes
     JOIN sessions ON sessions.id = session_classes.session_id
     WHERE sessions.session_code = ? ORDER BY session_classes.class_id`,
    [sessionCode],
  );
  const timetableIds = targets
    .map(target => target.timetableId)
    .filter(Boolean);

  const response = {
    ok: true,
    sessionCode,
    method,
    classIds: classRows.map(row => row.class_id),
    timetableIds,
    header: await getSessionHeader(sessionCode),
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

  if (!resumed) notifyClasses(response.classIds); // students' Today moves from "waiting" to "open" at once

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

  // Connect to the room's camera now, while the faculty is still on the start screen.
  if (method === 'cctv') void warmSessionCamera(sessionCode);
  return response;
}

function sendStartError(res, err) {
  if (err.status) {
    return res
      .status(err.status)
      .json({ ok: false, error: err.message, ...err.extra });
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
  if (/Sunday has no classes/.test(err.message)) {
    return res.status(400).json({ ok: false, error: 'no_class_on_sunday' });
  }
  if (/FOREIGN KEY/i.test(err.message)) {
    return res.status(400).json({ ok: false, error: 'invalid_class_or_room' });
  }
  console.error(err);
  return res.status(500).json({ ok: false, error: 'session_insert_failed' });
}

// Optional room override: the faculty teaches in another room than the one the timetable lists.
async function readRoomChoice(value) {
  if (value === undefined || value === null || value === '') return null;
  const roomId = Number(value);
  if (!Number.isInteger(roomId) || roomId <= 0) throw fail(400, 'invalid_room');
  const room = await dbGet(`SELECT id FROM rooms WHERE id = ?`, [roomId]);
  if (!room) throw fail(400, 'invalid_room');
  return roomId;
}

// Start session for one of the faculty's own planned periods.
// The timetable row decides which classes and batch the session is for. Optional extras:
//   roomId         the room it is really held in (defaults to the timetable's room; CCTV uses its camera)
// Merging other classes is done with an Extra session (POST /arranged), not here.
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
    const roomChoice = await readRoomChoice(req.body.roomId);

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

    const targets = [];
    for (const row of eligible) {
      targets.push({
        timetableId: row.id,
        slotId: row.slot_id,
        subjectId: row.subject_id,
        roomId: roomChoice ?? row.room_id,
        kind: 'regular',
        classes: await dbAll(
          `SELECT class_id, batch FROM timetable_classes WHERE timetable_id = ? ORDER BY class_id`,
          [row.id],
        ),
      });
    }

    return res.json(
      await startSessions({ date, facultyDbId, method, targets }),
    );
  } catch (err) {
    return sendStartError(res, err);
  }
});

// Extra / borrowed / Saturday class. The faculty picks classes they teach, a subject they teach and one or
// more periods. For each period:
//   - the faculty's own planned row            -> a normal session on that row
//   - another faculty's row (borrowing)        -> a session on THAT row, but taken by this faculty for
//                                                 their subject; the lender cannot start it any more
//   - nothing planned for these classes        -> an arranged session (no timetable row)
// Borrowing is instant. It is limited to the faculty's own classes.
router.post('/arranged', async (req, res) => {
  const { date, facultyId, method = 'qr' } = req.body;

  if (!isValidDate(date))
    return res.status(400).json({ ok: false, error: 'invalid_date' });
  if (method !== 'qr' && method !== 'cctv')
    return res.status(400).json({ ok: false, error: 'invalid_method' });
  const dayName = classDayName(date);
  if (!dayName)
    return res.status(400).json({ ok: false, error: 'no_class_on_sunday' });

  const classIds = uniqueIds(req.body.classIds).slice(0, 6);
  const slotIds = uniqueIds(req.body.slotIds).slice(0, 4);
  const subjectId = Number(req.body.subjectId);
  if (classIds.length === 0)
    return res.status(400).json({ ok: false, error: 'pick_classes' });
  if (slotIds.length === 0)
    return res.status(400).json({ ok: false, error: 'pick_periods' });
  if (!Number.isInteger(subjectId))
    return res.status(400).json({ ok: false, error: 'pick_subject' });

  try {
    const roomChoice = await readRoomChoice(req.body.roomId);
    const facultyDbId = await resolveFacultyId(facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });

    const subject = await dbGet(
      `SELECT id, takes_attendance FROM subjects WHERE id = ?`,
      [subjectId],
    );
    if (!subject)
      return res.status(400).json({ ok: false, error: 'pick_subject' });
    if (!subject.takes_attendance)
      return res
        .status(400)
        .json({ ok: false, error: 'subject_does_not_take_attendance' });

    // Limited to what the faculty teaches (their subjects and their classes), to keep borrowing simple.
    const mine = await dbGet(
      `SELECT 1 AS found FROM timetable
       WHERE faculty_id = ? AND subject_id = ? AND valid_from <= ?
         AND (valid_to IS NULL OR valid_to >= ?) LIMIT 1`,
      [facultyDbId, subjectId, date, date],
    );
    if (!mine)
      return res.status(403).json({ ok: false, error: 'subject_not_yours' });

    const classMarks = classIds.map(() => '?').join(', ');
    const myClasses = await dbAll(
      `SELECT DISTINCT timetable_classes.class_id AS id
       FROM timetable
       JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
       WHERE timetable.faculty_id = ? AND timetable.valid_from <= ?
         AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
         AND timetable_classes.class_id IN (${classMarks})`,
      [facultyDbId, date, date, ...classIds],
    );
    if (myClasses.length !== classIds.length)
      return res.status(403).json({ ok: false, error: 'class_not_yours' });

    const slotMarks = slotIds.map(() => '?').join(', ');
    const slots = await dbAll(
      `SELECT id FROM slots WHERE id IN (${slotMarks})`,
      slotIds,
    );
    if (slots.length !== slotIds.length)
      return res.status(400).json({ ok: false, error: 'invalid_slot' });

    const plannedDay = weekdayName(date); // null on a Saturday: nothing is planned
    // Only a period with a faculty and a subject that takes attendance counts as "planned". A row with no
    // faculty (TRAINING, PLACEMENT PREP) or a subject without attendance is free for an Extra session.
    const targets = [];
    for (const slotId of slotIds) {
      const rows = plannedDay
        ? await dbAll(
            `SELECT DISTINCT timetable.id, timetable.faculty_id, timetable.subject_id, timetable.room_id
             FROM timetable
             JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
             JOIN subjects ON subjects.id = timetable.subject_id
             WHERE timetable.day = ? AND timetable.slot_id = ?
               AND timetable.faculty_id IS NOT NULL AND subjects.takes_attendance = 1
               AND timetable.valid_from <= ?
               AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
               AND timetable_classes.class_id IN (${classMarks})
             ORDER BY timetable.id`,
            [plannedDay, slotId, date, date, ...classIds],
          )
        : [];

      const covered = new Set();
      for (const row of rows) {
        const rowClasses = await dbAll(
          `SELECT class_id, batch FROM timetable_classes WHERE timetable_id = ? ORDER BY class_id`,
          [row.id],
        );
        // Borrowing a combined lecture would leave its other classes without a teacher.
        if (rowClasses.some(cls => !classIds.includes(cls.class_id)))
          throw fail(400, 'borrow_partial');
        rowClasses.forEach(cls => covered.add(cls.class_id));
        const own = row.faculty_id === facultyDbId;
        targets.push({
          timetableId: row.id,
          slotId,
          subjectId: own ? row.subject_id : subjectId,
          roomId: roomChoice ?? row.room_id,
          kind: own ? 'regular' : 'borrowed',
          classes: rowClasses,
        });
      }
      const uncovered = classIds.filter(id => !covered.has(id));
      if (uncovered.length > 0) {
        targets.push({
          timetableId: null,
          slotId,
          subjectId,
          roomId: roomChoice,
          kind: 'arranged',
          classes: uncovered.map(class_id => ({ class_id, batch: null })),
        });
      }
    }

    return res.json(
      await startSessions({ date, facultyDbId, method, targets }),
    );
  } catch (err) {
    return sendStartError(res, err);
  }
});

// Rooms for the room picker, for one or more periods (?slotId=3 or ?slotId=3,4) on a date:
// which are already in use (disabled), and which the timetable plans for someone else (a hint only).
router.get('/rooms', async (req, res) => {
  const { date } = req.query;
  const slotIds = uniqueIds(String(req.query.slotId ?? '').split(','));
  const day = weekdayName(date) || '';
  try {
    const myId = (await resolveFacultyId(req.query.faculty_id)) ?? -1; // a faculty's own open session does not block their room
    const rooms = await dbAll(
      `SELECT id, block, number, type,
              (camera_url IS NOT NULL AND TRIM(camera_url) <> '') AS has_camera
       FROM rooms ORDER BY block, number`,
    );
    if (slotIds.length && isValidDate(date)) {
      const marks = slotIds.map(() => '?').join(', ');
      const inUse = await dbAll(
        `SELECT sessions.room_id, faculties.name AS faculty
         FROM sessions LEFT JOIN faculties ON faculties.id = sessions.faculty_id
         WHERE sessions.date = ? AND sessions.slot_id IN (${marks}) AND sessions.room_id IS NOT NULL
           AND sessions.end_time IS NULL AND (sessions.faculty_id IS NULL OR sessions.faculty_id <> ?)`,
        [date, ...slotIds, myId],
      );
      const planned = await dbAll(
        `SELECT timetable.room_id, subjects.abbr AS subject, faculties.abbr AS faculty
         FROM timetable
         JOIN subjects ON subjects.id = timetable.subject_id
         LEFT JOIN faculties ON faculties.id = timetable.faculty_id
         WHERE timetable.room_id IS NOT NULL AND timetable.day = ? AND timetable.slot_id IN (${marks})
           AND timetable.valid_from <= ? AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
           AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.timetable_id = timetable.id AND sessions.date = ?)`,
        [day, ...slotIds, date, date, date],
      );
      for (const room of rooms) {
        room.in_use_by =
          inUse.find(row => row.room_id === room.id)?.faculty || null;
        const plan = planned.find(row => row.room_id === room.id);
        room.planned = plan
          ? `${plan.subject}${plan.faculty ? ` · ${plan.faculty}` : ''}`
          : null;
      }
    }
    return res.json(rooms);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Arranged class, step 1: the classes and subjects this faculty teaches (with each class's home room).
router.get('/arranged/options', async (req, res) => {
  const { date, faculty_id } = req.query;
  if (!isValidDate(date))
    return res.json({ closed: true, classes: [], subjects: [] });
  if (!classDayName(date))
    return res.json({ closed: true, classes: [], subjects: [] });
  try {
    const facultyDbId = await resolveFacultyId(faculty_id);
    if (!facultyDbId)
      return res.json({ closed: false, classes: [], subjects: [] });
    const classes = await dbAll(
      `SELECT DISTINCT classes.id AS class_id, courses.abbr AS course, branches.abbr AS branch,
         classes.semester, classes.section, classes.room_id,
         CASE WHEN rooms.id IS NULL THEN NULL ELSE rooms.block || '-' || rooms.number END AS room
       FROM timetable
       JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
       JOIN classes ON classes.id = timetable_classes.class_id
       JOIN branches ON branches.id = classes.branch_id
       JOIN courses ON courses.id = branches.course_id
       LEFT JOIN rooms ON rooms.id = classes.room_id
       WHERE timetable.faculty_id = ? AND timetable.valid_from <= ?
         AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
       ORDER BY courses.abbr, branches.abbr, classes.semester, classes.section`,
      [facultyDbId, date, date],
    );
    const subjects = await dbAll(
      `SELECT DISTINCT subjects.id, subjects.name, subjects.abbr
       FROM timetable JOIN subjects ON subjects.id = timetable.subject_id
       WHERE timetable.faculty_id = ? AND subjects.takes_attendance = 1
         AND timetable.valid_from <= ? AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
       ORDER BY subjects.name`,
      [facultyDbId, date, date],
    );
    return res.json({ closed: false, classes, subjects });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Arranged class, step 2: every period for the chosen classes and what can be done with it.
//   free     nothing planned: an extra class
//   own      the faculty's own planned period
//   borrow   another faculty's planned period: taking it is instant
//   mine     the faculty already started it (resumes)
//   taken    another faculty already holds it (disabled)
//   blocked  a combined lecture that includes classes not chosen (disabled)
router.get('/arranged/slots', async (req, res) => {
  const { date, faculty_id } = req.query;
  const classIds = uniqueIds(String(req.query.classIds ?? '').split(','));
  if (!isValidDate(date) || !classDayName(date)) return res.json([]);
  try {
    const facultyDbId = await resolveFacultyId(faculty_id);
    const slots = await dbAll(
      `SELECT id, label, start_time, end_time FROM slots ORDER BY start_time`,
    );
    if (!facultyDbId || classIds.length === 0)
      return res.json(
        slots.map(slot => ({ ...slot, status: 'free', note: '' })),
      );

    const marks = classIds.map(() => '?').join(', ');
    const day = weekdayName(date);
    const planned = day
      ? await dbAll(
          `SELECT DISTINCT timetable.id, timetable.slot_id, timetable.faculty_id,
                  faculties.name AS faculty, subjects.abbr AS subject,
                  (timetable.faculty_id IS NOT NULL AND subjects.takes_attendance = 1) AS counts
           FROM timetable
           JOIN timetable_classes ON timetable_classes.timetable_id = timetable.id
           JOIN subjects ON subjects.id = timetable.subject_id
           LEFT JOIN faculties ON faculties.id = timetable.faculty_id
           WHERE timetable.day = ? AND timetable.valid_from <= ?
             AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
             AND timetable_classes.class_id IN (${marks})`,
          [day, date, date, ...classIds],
        )
      : [];
    const partial = new Set();
    for (const row of planned.filter(row => row.counts)) {
      const outside = await dbGet(
        `SELECT 1 AS found FROM timetable_classes
         WHERE timetable_id = ? AND class_id NOT IN (${marks}) LIMIT 1`,
        [row.id, ...classIds],
      );
      if (outside) partial.add(row.id);
    }
    const held = await dbAll(
      `SELECT DISTINCT sessions.slot_id, sessions.faculty_id, faculties.name AS faculty
       FROM sessions
       JOIN session_classes ON session_classes.session_id = sessions.id
       LEFT JOIN faculties ON faculties.id = sessions.faculty_id
       WHERE sessions.date = ? AND session_classes.class_id IN (${marks})`,
      [date, ...classIds],
    );

    return res.json(
      slots.map(slot => {
        const holders = held.filter(row => row.slot_id === slot.id);
        const all = planned.filter(row => row.slot_id === slot.id);
        // A period with no faculty, or a subject that takes no attendance, is free to use.
        const rows = all.filter(row => row.counts);
        const lender = rows.filter(row => row.faculty_id !== facultyDbId);
        const names = [
          ...new Set(lender.map(row => row.faculty || 'another faculty')),
        ].join(', ');
        const subjects = [...new Set(rows.map(row => row.subject))].join(', ');

        const stranger = holders.find(row => row.faculty_id !== facultyDbId);
        if (stranger)
          return {
            ...slot,
            status: 'taken',
            note: `Taken by ${stranger.faculty || 'another faculty'}`,
          };
        if (holders.length)
          return { ...slot, status: 'mine', note: 'Already started: resumes' };
        if (rows.some(row => partial.has(row.id)))
          return {
            ...slot,
            status: 'blocked',
            note: `${subjects}: combined with other classes`,
          };
        if (lender.length)
          return {
            ...slot,
            status: 'borrow',
            note: `Borrow from ${names} (${subjects})`,
          };
        if (rows.length)
          return { ...slot, status: 'own', note: `Your period (${subjects})` };
        const idle = [...new Set(all.map(row => row.subject))].join(', ');
        return {
          ...slot,
          status: 'free',
          note: idle ? `Free (${idle}, no attendance)` : 'Free',
        };
      }),
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// ---------------------------------------------------------------------------
// Discard (before submit only). The period becomes free again.
// Without `force`, a session with marks is refused (409 session_has_marks, with the count).
// With `force: true` the client must also send `confirmMarked`, the number it told the faculty would be removed.
// If more students were marked since then, nothing is deleted (409 marks_changed) so the faculty can confirm again.
// Every discard, with or without marks, leaves a row in session_discard_log.
// ---------------------------------------------------------------------------
const ensureDiscardLog = () =>
  dbRun(`CREATE TABLE IF NOT EXISTS session_discard_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_code TEXT NOT NULL,
    faculty_id INTEGER,
    faculty_name TEXT,
    session_date DATE,
    subject TEXT,
    classes TEXT,
    method TEXT,
    student_count INTEGER NOT NULL DEFAULT 0,
    marked_count INTEGER NOT NULL DEFAULT 0,
    forced INTEGER NOT NULL DEFAULT 0,
    discarded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

router.post('/cancel', async (req, res) => {
  const { sessionCode, facultyId } = req.body;
  const force = req.body.force === true;
  if (!sessionCode)
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  try {
    const facultyDbId = await resolveFacultyId(facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });
    const rows = await getSessionRows(sessionCode);
    if (rows.length === 0)
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    if (rows.some(row => row.faculty_id !== facultyDbId))
      return res.status(403).json({ ok: false, error: 'not_your_session' });
    if (isSessionEnded(rows))
      return res.status(400).json({ ok: false, error: 'session_ended' });

    const ids = `SELECT id FROM sessions WHERE session_code = ?`;
    const counts = await dbGet(
      `SELECT COUNT(DISTINCT student_id) AS students,
              COUNT(DISTINCT CASE WHEN marked_at IS NOT NULL THEN student_id END) AS marked
       FROM attendance WHERE session_id IN (${ids})`,
      [sessionCode],
    );
    const marked = counts.marked;
    if (marked > 0 && !force)
      return res
        .status(409)
        .json({ ok: false, error: 'session_has_marks', marked });
    if (marked > 0) {
      const confirmed = Number(req.body.confirmMarked);
      if (
        !Number.isSafeInteger(confirmed) ||
        confirmed < 0 ||
        marked > confirmed
      )
        return res
          .status(409)
          .json({ ok: false, error: 'marks_changed', marked });
    }

    const header = await getSessionHeader(sessionCode);
    const faculty = await dbGet(`SELECT name FROM faculties WHERE id = ?`, [
      facultyDbId,
    ]);
    const classes = (header?.classes || [])
      .map(
        c =>
          `${c.branch}-${c.semester}${c.section}${c.batch ? ` ${c.batch}` : ''}`,
      )
      .join(', ');

    // Close the room's camera connection first: once the session is gone there is no room to look up.
    await releaseSessionCamera(sessionCode);
    await ensureDiscardLog(); // CREATE TABLE inside a transaction is fine, but keep it out of the queue
    await withTransaction(async () => {
      await dbRun(
        `INSERT INTO session_discard_log
           (session_code, faculty_id, faculty_name, session_date, subject, classes, method, student_count, marked_count, forced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionCode,
          facultyDbId,
          faculty?.name ?? null,
          rows[0].date,
          header?.subject_label ?? null,
          classes,
          rows[0].method,
          counts.students,
          marked,
          marked > 0 ? 1 : 0,
        ],
      );
      await dbRun(`DELETE FROM attendance WHERE session_id IN (${ids})`, [
        sessionCode,
      ]);
      await dbRun(`DELETE FROM session_classes WHERE session_id IN (${ids})`, [
        sessionCode,
      ]);
      await dbRun(`DELETE FROM sessions WHERE session_code = ?`, [sessionCode]);
    });

    getIO().to(sessionCode).emit('session_finalized', { sessionCode });
    notifyClasses((header?.classes || []).map(c => c.class_id)); // their Today stops showing the discarded period
    return res.json({ ok: true, message: 'Discarded', removed: marked });
  } catch (err) {
    if (err.status)
      return res.status(err.status).json({ ok: false, error: err.message });
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// ---------------------------------------------------------------------------
// The faculty's open session, so a refresh (or a second device) can pick it up again. Only sessions started in the
// last 12 hours come back, so one that was forgotten days ago does not reopen every time the page loads.
// Also the way to re-read who is marked after the live connection dropped: ?code=... returns the same marks
// for that one session while it is still open.
// ---------------------------------------------------------------------------
const isoUtc = value => (value ? `${String(value).replace(' ', 'T')}Z` : null);

async function sessionMarks(sessionCode) {
  const rows = await dbAll(
    `SELECT students.id AS id, students.name AS name, students.roll_number AS roll_number,
            attendance.method AS method, MIN(attendance.marked_at) AS marked_at
     FROM attendance
     JOIN sessions ON sessions.id = attendance.session_id
     JOIN students ON students.id = attendance.student_id
     WHERE sessions.session_code = ? AND attendance.marked_at IS NOT NULL
     GROUP BY students.id
     ORDER BY MIN(attendance.marked_at), students.name`,
    [sessionCode],
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    rollNumber: row.roll_number,
    method: row.method,
    markedAt: isoUtc(row.marked_at),
  }));
}

router.get('/active', async (req, res) => {
  try {
    const facultyDbId = await resolveFacultyId(req.query.facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });

    const code = String(req.query.code ?? '');
    const open = await dbGet(
      code
        ? `SELECT session_code, method, date FROM sessions
           WHERE faculty_id = ? AND session_code = ? AND end_time IS NULL LIMIT 1`
        : `SELECT session_code, method, date FROM sessions
           WHERE faculty_id = ? AND end_time IS NULL AND start_time >= datetime('now', '-12 hours')
           ORDER BY id DESC LIMIT 1`,
      code ? [facultyDbId, code] : [facultyDbId],
    );
    if (!open) return res.json({ ok: true, active: null });

    const sessionCode = open.session_code;
    const header = await getSessionHeader(sessionCode);
    const response = {
      ok: true,
      active: {
        sessionCode,
        method: open.method,
        date: open.date,
        header,
        marks: await sessionMarks(sessionCode),
        token:
          open.method === 'qr'
            ? createSessionToken(
                sessionCode,
                TOKEN_LIFETIME_SECONDS,
                await getSessionSections(sessionCode),
              )
            : null,
      },
    };
    return res.json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// ---------------------------------------------------------------------------
// History: this faculty's submitted sessions, newest first, and one session in detail.
// ---------------------------------------------------------------------------
router.get('/history', async (req, res) => {
  try {
    const facultyDbId = await resolveFacultyId(req.query.facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const codes = await dbAll(
      `SELECT session_code, MAX(id) AS last_id FROM sessions
       WHERE faculty_id = ? AND end_time IS NOT NULL
       GROUP BY session_code ORDER BY last_id DESC LIMIT ? OFFSET ?`,
      [facultyDbId, limit + 1, offset],
    );
    const page = codes.slice(0, limit);
    const items = [];
    for (const { session_code: sessionCode } of page) {
      const header = await getSessionHeader(sessionCode);
      if (!header) continue;
      const counts = await dbGet(
        `SELECT COUNT(DISTINCT attendance.student_id) AS total,
                COUNT(DISTINCT CASE WHEN attendance.marked_at IS NOT NULL THEN attendance.student_id END) AS present
         FROM attendance JOIN sessions ON sessions.id = attendance.session_id
         WHERE sessions.session_code = ?`,
        [sessionCode],
      );
      const meta = await dbGet(
        `SELECT MIN(date) AS date, MIN(method) AS method, MAX(end_time) AS ended FROM sessions WHERE session_code = ?`,
        [sessionCode],
      );
      items.push({
        sessionCode,
        date: meta.date,
        method: meta.method,
        endedAt: isoUtc(meta.ended),
        header,
        present: counts.present,
        total: counts.total,
      });
    }
    return res.json({
      ok: true,
      sessions: items,
      hasMore: codes.length > limit,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.get('/history/:sessionCode', async (req, res) => {
  try {
    const facultyDbId = await resolveFacultyId(req.query.facultyId);
    if (!facultyDbId)
      return res.status(404).json({ ok: false, error: 'faculty_not_found' });
    const sessionCode = req.params.sessionCode;
    const rows = await getSessionRows(sessionCode);
    if (rows.length === 0)
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    if (rows.some(row => row.faculty_id !== facultyDbId))
      return res.status(403).json({ ok: false, error: 'not_your_session' });
    if (!isSessionEnded(rows))
      return res
        .status(409)
        .json({ ok: false, error: 'session_not_submitted' });

    const students = await dbAll(
      `SELECT students.id AS id, students.name AS name, students.roll_number AS roll_number,
              MAX(attendance.marked_at IS NOT NULL) AS present, attendance.method AS method,
              MIN(attendance.marked_at) AS marked_at
       FROM attendance
       JOIN sessions ON sessions.id = attendance.session_id
       JOIN students ON students.id = attendance.student_id
       WHERE sessions.session_code = ?
       GROUP BY students.id
       ORDER BY students.name, students.id`,
      [sessionCode],
    );
    return res.json({
      ok: true,
      sessionCode,
      date: rows[0].date,
      method: rows[0].method,
      endedAt: isoUtc(
        rows
          .map(r => r.end_time)
          .sort()
          .at(-1),
      ),
      header: await getSessionHeader(sessionCode),
      students: students.map(s => ({
        id: s.id,
        name: s.name,
        rollNumber: s.roll_number,
        present: Boolean(s.present),
        method: s.present ? s.method : null,
        markedAt: isoUtc(s.marked_at),
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
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
    // Students' Today and Attendance change now (absent people may have been marked, or the other way round)
    getSessionHeader(sessionCode)
      .then(h => notifyClasses((h?.classes || []).map(c => c.class_id)))
      .catch(() => {});
    // The class is over: close its camera connection (no-op for QR sessions).
    void releaseSessionCamera(sessionCode);
    // CCTV only: crops of the students the faculty confirmed join their galleries (no-op for QR sessions).
    void growGalleryFromSession(sessionCode, checkedStudentIds).catch(error =>
      console.warn(
        `[cctv] could not add face crops to galleries: ${error.message}`,
      ),
    );
    return res.json({ ok: true, message: 'Finalized' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Checked when the request reaches the server, so it must cover slow campus Wi-Fi.
// The QR still rotates every few seconds, so a screenshot is useless.
const TOKEN_LIFETIME_SECONDS = 3;

function createSessionToken(sessionCode, expiresInSeconds, section) {
  const token = randomBytes(12).toString('hex');
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  utils.activeTokens[token] = { sessionCode, section, expiresAt };

  setTimeout(() => delete utils.activeTokens[token], expiresInSeconds * 1000);
  return token;
}

export default router;
