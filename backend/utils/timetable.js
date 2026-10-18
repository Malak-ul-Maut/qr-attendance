import { dbAll, dbGet } from './db.js';

// Faculty id from the username the frontend sends (a numeric id also works).
export async function resolveFacultyId(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const numeric = /^\d+$/.test(text) ? Number(text) : -1;
  const row = await dbGet(
    `SELECT id FROM faculties WHERE username = ? OR id = ? ORDER BY username = ? DESC LIMIT 1`,
    [text, numeric, text],
  );
  return row?.id ?? null;
}

// Timetable rows in force on `date` for this faculty, day and slot.
export function findTimetableRows(facultyId, date, day, slotId) {
  return dbAll(
    `
    SELECT timetable.id, timetable.room_id, timetable.slot_id, timetable.subject_id,
      subjects.takes_attendance
    FROM timetable
    JOIN subjects ON subjects.id = timetable.subject_id
    WHERE timetable.faculty_id = ?
      AND timetable.day = ?
      AND timetable.slot_id = ?
      AND timetable.valid_from <= ?
      AND (timetable.valid_to IS NULL OR timetable.valid_to >= ?)
    ORDER BY timetable.id
    `,
    [facultyId, day, slotId, date, date],
  );
}

// Every session row that shares one session code (one per period / timetable row).
export function getSessionRows(sessionCode) {
  return dbAll(
    `SELECT id, timetable_id, date, method, start_time, end_time, slot_id, subject_id, faculty_id, room_id, kind
     FROM sessions WHERE session_code = ? ORDER BY id`,
    [sessionCode],
  );
}

export const isSessionEnded = rows => rows.every(row => row.end_time !== null);

// 'A' or 'A,D': the sections of the classes a session covers. Used in the QR token.
export async function getSessionSections(sessionCode) {
  const rows = await dbAll(
    `
    SELECT DISTINCT classes.section
    FROM sessions
    JOIN session_classes ON session_classes.session_id = sessions.id
    JOIN classes ON classes.id = session_classes.class_id
    WHERE sessions.session_code = ?
    ORDER BY classes.section
    `,
    [sessionCode],
  );
  return rows.map(row => row.section).join(',');
}

// Everyone in a session. This reads the attendance rows created when the session started,
// so it is exactly the group (class + batch) the session was opened for.
export function getSessionStudents(sessionCode) {
  return dbAll(
    `
    SELECT DISTINCT students.id, students.username, students.name,
      students.roll_number AS roll_number,
      (SELECT session_classes.class_id
         FROM session_classes
         JOIN students_mapping ON students_mapping.class_id = session_classes.class_id
          AND students_mapping.student_id = students.id
        WHERE session_classes.session_id = sessions.id
        LIMIT 1) AS class_id
    FROM sessions
    JOIN attendance ON attendance.session_id = sessions.id
    JOIN students ON students.id = attendance.student_id
    WHERE sessions.session_code = ?
    ORDER BY students.name, students.id
    `,
    [sessionCode],
  );
}

// Who already has a session in this date + period for any of these classes (a borrower or a merging
// faculty). Used to say "Taken by Prof. X" instead of a bare error. Null when nobody does.
export async function findSlotHolder(date, slotId, classIds, exceptFacultyId = null) {
  if (!classIds.length) return null;
  const marks = classIds.map(() => '?').join(', ');
  const row = await dbGet(
    `
    SELECT DISTINCT faculties.name AS name, sessions.faculty_id AS faculty_id, sessions.kind AS kind
    FROM sessions
    JOIN session_classes ON session_classes.session_id = sessions.id
    LEFT JOIN faculties ON faculties.id = sessions.faculty_id
    WHERE sessions.date = ? AND sessions.slot_id = ?
      AND session_classes.class_id IN (${marks})
      AND (? IS NULL OR sessions.faculty_id IS NULL OR sessions.faculty_id <> ?)
    LIMIT 1
    `,
    [date, slotId, ...classIds, exceptFacultyId, exceptFacultyId],
  );
  return row ? { name: row.name || 'another faculty', kind: row.kind } : null;
}

// What the live session screen shows: subject, room, periods and every class covered.
export async function getSessionHeader(sessionCode) {
  const sessions = await dbAll(
    `
    SELECT sessions.id, sessions.kind, sessions.date, subjects.name AS subject_name, subjects.abbr AS subject_abbr,
      slots.label, slots.start_time, slots.end_time, rooms.block, rooms.number AS room_number
    FROM sessions
    JOIN subjects ON subjects.id = sessions.subject_id
    JOIN slots ON slots.id = sessions.slot_id
    LEFT JOIN rooms ON rooms.id = sessions.room_id
    WHERE sessions.session_code = ?
    ORDER BY slots.start_time, sessions.id
    `,
    [sessionCode],
  );
  if (sessions.length === 0) return null;
  const classes = await dbAll(
    `
    SELECT DISTINCT classes.id AS class_id, courses.abbr AS course, branches.abbr AS branch,
      classes.semester, classes.section, session_classes.batch, session_classes.merged
    FROM sessions
    JOIN session_classes ON session_classes.session_id = sessions.id
    JOIN classes ON classes.id = session_classes.class_id
    JOIN branches ON branches.id = classes.branch_id
    JOIN courses ON courses.id = branches.course_id
    WHERE sessions.session_code = ?
    ORDER BY classes.id, session_classes.batch
    `,
    [sessionCode],
  );
  const periods = [];
  for (const row of sessions) {
    if (!periods.some(p => p.start_time === row.start_time))
      periods.push({ label: row.label, start_time: row.start_time, end_time: row.end_time });
  }
  const first = sessions[0];
  return {
    subject_label: first.subject_name,
    subject_abbr: first.subject_abbr,
    block: first.block,
    room_number: first.room_number,
    periods,
    kinds: [...new Set(sessions.map(row => row.kind))],
    classes,
  };
}
