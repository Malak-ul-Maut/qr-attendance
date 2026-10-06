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
    SELECT timetable.id, timetable.room_id, subjects.takes_attendance
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

// Every session row that shares one session code (one per timetable row).
export function getSessionRows(sessionCode) {
  return dbAll(
    `SELECT id, timetable_id, date, method, start_time, end_time
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
    JOIN timetable_classes ON timetable_classes.timetable_id = sessions.timetable_id
    JOIN classes ON classes.id = timetable_classes.class_id
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
      students.roll_number AS roll_number
    FROM sessions
    JOIN attendance ON attendance.session_id = sessions.id
    JOIN students ON students.id = attendance.student_id
    WHERE sessions.session_code = ?
    ORDER BY students.name, students.id
    `,
    [sessionCode],
  );
}
