import express from 'express';
import { dbGet, dbRun } from '../utils/db.js';
import utils from '../utils/in-memory-db.js';
import { getIO } from '../utils/socket-io.js';
import { getSessionRows, isSessionEnded } from '../utils/timetable.js';
import { todayLocal } from '../utils/dates.js';

const router = express.Router();

// Verify student scan.
// A session creates an attendance row for every student when it starts, so "marking" a
// student means filling in marked_at (+ method) on the row that already exists.
router.post('/verify', async (req, res) => {
  const currentDate = new Date();

  // studentId is the student's username. `section` is still sent by the app, but
  // eligibility now comes from the session's own attendance rows, so it is not needed.
  const { studentId, token, sessionId, cameraFingerprint, isFaceScanned } =
    req.body;

  if (!isFaceScanned) {
    const tokenData = utils.activeTokens[token];
    if (!tokenData || tokenData.expiresAt <= Date.now())
      return res
        .status(400)
        .json({ ok: false, error: 'invalid_or_expired_token' });

    try {
      const check = await checkStudentForSession(
        tokenData.sessionCode,
        studentId,
      );
      if (check.error)
        return res
          .status(400)
          .json({ ok: false, error: check.error, subject: check.subject });

      return res.json({
        ok: true,
        sessionId: tokenData.sessionCode,
        section: tokenData.section,
        subject: check.subject,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'database_error' });
    }
  }

  try {
    const check = await checkStudentForSession(sessionId, studentId);
    if (check.error)
      return res
        .status(400)
        .json({ ok: false, error: check.error, subject: check.subject });
    const student = check.student;

    // Same phone already used by someone else in this session?
    if (cameraFingerprint) {
      const sameDevice = await dbGet(
        `
        SELECT 1 AS found
        FROM attendance
        JOIN sessions ON sessions.id = attendance.session_id
        WHERE sessions.session_code = ?
          AND attendance.camera_fingerprint = ?
          AND attendance.student_id <> ?
          AND attendance.marked_at IS NOT NULL
        LIMIT 1
        `,
        [sessionId, cameraFingerprint, student.student_id],
      );
      if (sameDevice)
        return res
          .status(400)
          .json({ ok: false, error: 'duplicate_device_entry' });
    }

    // marked_at IS NULL in the WHERE makes a double scan a no-op instead of an overwrite.
    const { changes } = await dbRun(
      `UPDATE attendance
       SET marked_at = datetime('now'), method = 'qr', camera_fingerprint = ?
       WHERE id = ? AND marked_at IS NULL`,
      [cameraFingerprint || null, student.attendance_id],
    );
    if (changes === 0)
      return res.status(400).json({ ok: false, error: 'already_marked' });

    getIO().to(sessionId).emit('attendance_update', {
      studentId: student.student_id,
      studentName: student.student_name,
      section: student.section,
      sessionId,
      time: currentDate.toLocaleTimeString(),
    });
    return res.json({
      ok: true,
      message: 'Attendance recorded',
      subject: check.subject,
      markedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Lets the face-check screen notice that the teacher closed attendance mid-check.
// open:true means the student can still mark; otherwise `error` says why not.
router.get('/session-status', async (req, res) => {
  const sessionId = String(req.query.sessionId ?? '');
  const studentId = String(req.query.studentId ?? '');
  if (!sessionId || !studentId)
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  try {
    const check = await checkStudentForSession(sessionId, studentId);
    return res.json({ ok: true, open: !check.error, error: check.error });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Mark faculty-selected students present by hand.
// Only students who belong to the session (they have an attendance row) are accepted.
router.post('/manual', async (req, res) => {
  const { sessionCode, students = [] } = req.body;
  const time = new Date().toLocaleTimeString();

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }
  if (!Array.isArray(students)) {
    return res.status(400).json({ ok: false, error: 'invalid_students' });
  }

  try {
    const sessionRows = await getSessionRows(sessionCode);
    if (sessionRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }
    if (isSessionEnded(sessionRows)) {
      return res.status(400).json({ ok: false, error: 'session_ended' });
    }

    const io = getIO();
    let added = 0;

    for (const student of students) {
      const row = await dbGet(
        `
        SELECT attendance.id, attendance.marked_at, students.id AS student_id,
          students.name
        FROM attendance
        JOIN sessions ON sessions.id = attendance.session_id
        JOIN students ON students.id = attendance.student_id
        WHERE sessions.session_code = ? AND attendance.student_id = ?
        LIMIT 1
        `,
        [sessionCode, Number(student?.id)],
      );
      if (!row) continue; // not part of this session

      if (!row.marked_at) {
        await dbRun(
          `UPDATE attendance SET marked_at = datetime('now'), method = 'manual'
           WHERE id = ? AND marked_at IS NULL`,
          [row.id],
        );
      }

      added++;
      io.to(sessionCode).emit('attendance_update', {
        studentId: row.student_id,
        studentName: student.name || row.name,
        sessionCode,
        time,
        method: 'manual',
      });
    }

    return res.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Why a student can or cannot mark in this session, as one specific error code:
// session_not_found, session_ended, wrong_method, account_inactive, not_on_roster,
// already_marked. On success returns { student, subject }.
async function checkStudentForSession(sessionCode, username) {
  const rows = await getSessionRows(sessionCode);
  if (rows.length === 0) return { error: 'session_not_found' };

  const subjectRow = await dbGet(
    `SELECT subjects.name AS name
     FROM sessions
     JOIN timetable ON timetable.id = sessions.timetable_id
     JOIN subjects ON subjects.id = timetable.subject_id
     WHERE sessions.session_code = ? LIMIT 1`,
    [sessionCode],
  );
  const subject = subjectRow?.name ?? null;

  // A session left open from an earlier day counts as ended.
  const today = todayLocal();
  if (isSessionEnded(rows) || rows.every(row => row.date !== today))
    return { error: 'session_ended', subject };
  // Camera (CCTV) sessions are marked by the camera, never by a phone.
  if (rows.some(row => row.method !== 'qr'))
    return { error: 'wrong_method', subject };

  const account = await dbGet(
    `SELECT id, active, face_embedding IS NOT NULL AS has_face, face_status FROM students WHERE username = ?`,
    [String(username ?? '')],
  );
  if (!account) return { error: 'not_on_roster', subject };
  if (!account.active) return { error: 'account_inactive', subject };
  // QR attendance needs photos an admin has approved; otherwise the teacher marks the student by hand
  if (account.face_status !== 'approved')
    return { error: account.has_face ? 'face_not_approved' : 'face_not_enrolled', subject };

  const student = await getEligibleStudent(sessionCode, username);
  if (!student) return { error: 'not_on_roster', subject };
  if (student.marked_at) return { error: 'already_marked', subject };
  return { student, subject };
}

// The student's row in an open session, found by session code + username.
function getEligibleStudent(sessionCode, username) {
  return dbGet(
    `
    SELECT
      attendance.id AS attendance_id,
      attendance.marked_at,
      students.id AS student_id,
      students.name AS student_name,
      (
        SELECT classes.section
        FROM students_mapping
        JOIN classes ON classes.id = students_mapping.class_id
        JOIN timetable_classes
          ON timetable_classes.class_id = classes.id
          AND timetable_classes.timetable_id = sessions.timetable_id
        WHERE students_mapping.student_id = students.id
        LIMIT 1
      ) AS section
    FROM sessions
    JOIN attendance ON attendance.session_id = sessions.id
    JOIN students ON students.id = attendance.student_id
    WHERE sessions.session_code = ?
      AND students.username = ?
      AND students.active = 1
      AND sessions.end_time IS NULL
    LIMIT 1
    `,
    [sessionCode, String(username ?? '')],
  );
}

export default router;
