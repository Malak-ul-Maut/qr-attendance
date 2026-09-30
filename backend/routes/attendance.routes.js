import express from 'express';
import db from '../utils/db.js';
import utils from '../utils/in-memory-db.js';
import { getIO } from '../utils/socket-io.js';

const router = express.Router();

// Verify student scan
router.post('/verify', async (req, res) => {
  const currentDate = new Date();
  const timestamp = currentDate.toLocaleString();

  let {
    studentId,
    token,
    sessionId,
    section,
    cameraFingerprint,
    isFaceScanned,
  } = req.body;

  if (!isFaceScanned) {
    const tokenData = utils.activeTokens[token];
    if (!tokenData || tokenData.expiresAt <= Date.now())
      return res
        .status(400)
        .json({ ok: false, error: 'invalid_or_expired_token' });

    try {
      const student = await getEligibleStudent(
        tokenData.sessionCode,
        tokenData.section,
        studentId,
      );
      if (!student)
        return res.status(400).json({ ok: false, error: 'not_your_section' });

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
    const student = await getEligibleStudent(sessionId, section, studentId);
    if (!student)
      return res.status(400).json({ ok: false, error: 'not_your_section' });

    const existing = await getDb(
      `
      SELECT student_id, camera_fingerprint
      FROM attendance
      WHERE session_id = ?
        AND (
          student_id = ?
          OR (? IS NOT NULL AND camera_fingerprint = ?)
        )
      `,
      [
        student.session_id,
        student.student_id,
        cameraFingerprint || null,
        cameraFingerprint || null,
      ],
    );
    if (existing?.student_id === student.student_id)
      return res.status(400).json({ ok: false, error: 'already_marked' });
    if (existing)
      return res
        .status(400)
        .json({ ok: false, error: 'duplicate_device_entry' });

    const changes = await insertAttendance(
      student.session_id,
      student.student_id,
      timestamp,
      cameraFingerprint,
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

// Add faculty-selected students to the pending attendance checklist.
// Resolve each student to the session row whose timetable class matches the student.
router.post('/manual', async (req, res) => {
  const { sessionCode, students = [] } = req.body;
  const time = new Date().toLocaleTimeString();

  if (!sessionCode) {
    return res.status(400).json({ ok: false, error: 'missing_session_code' });
  }

  try {
    const sessionRows = await allDb(
      `
      SELECT sessions.id AS session_id, classes.id AS class_id
      FROM sessions
      JOIN timetable ON timetable.id = sessions.timetable_id
      JOIN classes ON classes.room_id = timetable.room_id
      WHERE sessions.session_code = ?
      `,
      [sessionCode],
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'session_not_found' });
    }

    const io = getIO();
    let added = 0;

    for (const student of students) {
      const dbStudent = await getDb(
        `SELECT id, class_id FROM students WHERE id = ?`,
        [student.id],
      );
      if (!dbStudent) continue;

      const session = sessionRows.find(
        row => row.class_id === dbStudent.class_id,
      );
      if (!session) continue;

      added++;
      io.to(sessionCode).emit('attendance_update', {
        studentId: dbStudent.id,
        studentName: student.name,
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

function allDb(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getEligibleStudent(sessionCode, section, username) {
  return getDb(
    `
    SELECT
      sessions.id AS session_id,
      students.id AS student_id,
      users.name AS student_name,
      sections.label AS section
    FROM sessions
    JOIN timetable ON timetable.id = sessions.timetable_id
    JOIN classes ON classes.room_id = timetable.room_id
    JOIN sections ON sections.id = classes.section_id
    JOIN students ON students.class_id = classes.id
    JOIN users ON users.id = students.user_id
    WHERE sessions.session_code = ?
      AND sections.label = ?
      AND users.username = ?
      AND users.role = 'student'
      AND sessions.end_time IS NULL
    LIMIT 1
    `,
    [sessionCode, section, username],
  );
}

function getDb(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function insertAttendance(
  sessionId,
  studentId,
  timestamp,
  cameraFingerprint = null,
) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO attendance
        (session_id, student_id, status, timestamp, camera_fingerprint)
       VALUES (?, ?, 'present', ?, ?)`,
      [sessionId, studentId, timestamp, cameraFingerprint || null],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes);
      },
    );
  });
}

export default router;
