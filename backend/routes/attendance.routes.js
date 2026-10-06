import express from 'express';
import { dbGet, dbRun } from '../utils/db.js';
import utils from '../utils/in-memory-db.js';
import { getIO } from '../utils/socket-io.js';
import { getSessionRows, isSessionEnded } from '../utils/timetable.js';

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
      const student = await getEligibleStudent(
        tokenData.sessionCode,
        studentId,
      );
      if (!student)
        return res.status(400).json({ ok: false, error: 'not_your_section' });
      if (student.marked_at)
        return res.status(400).json({ ok: false, error: 'already_marked' });

      return res.json({
        ok: true,
        sessionId: tokenData.sessionCode,
        section: tokenData.section,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'database_error' });
    }
  }

  try {
    const student = await getEligibleStudent(sessionId, studentId);
    if (!student)
      return res.status(400).json({ ok: false, error: 'not_your_section' });
    if (student.marked_at)
      return res.status(400).json({ ok: false, error: 'already_marked' });

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
    return res.json({ ok: true, message: 'Attendance recorded' });
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
