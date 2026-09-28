import express from 'express';
import db from '../utils/db.js';

const router = express.Router();

db.run(`
  CREATE TABLE IF NOT EXISTS face_descriptors (
    student_id INTEGER PRIMARY KEY REFERENCES students(id),
    descriptor TEXT NOT NULL
  )
`);

router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT users.username, users.name, users.password,
        sections.label AS section
      FROM users
      JOIN students ON students.user_id = users.id
      JOIN classes ON classes.id = students.class_id
      JOIN sections ON sections.id = classes.section_id
      WHERE users.role = 'student'
      ORDER BY users.name
    `);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.get('/descriptors', async (req, res) => {
  try {
    const row = await dbGet(
      `
      SELECT face_descriptors.descriptor
      FROM face_descriptors
      JOIN students ON students.id = face_descriptors.student_id
      JOIN users ON users.id = students.user_id
      WHERE users.username = ?
      `,
      [req.query.id],
    );
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json(JSON.parse(row.descriptor));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.get('/:sessionCode', (req, res) => {
  const sessionCode = req.params.sessionCode;

  db.all(
    `
    SELECT DISTINCT students.id AS id, users.username, users.name
    FROM sessions
    JOIN timetable ON timetable.id = sessions.timetable_id
    JOIN classes ON classes.room_id = timetable.room_id
    JOIN students ON students.class_id = classes.id
    JOIN users ON users.id = students.user_id
    WHERE sessions.session_code = ?`,
    [sessionCode],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false });
      }

      return res.json(rows);
    },
  );
});

router.post('/', async (req, res) => {
  const { username, name, password, faceDescriptor } = req.body;

  try {
    const classId = await resolveClassId(req.body);
    if (!username || !name || !classId)
      return res.status(400).json({ ok: false, error: 'invalid_student_data' });

    const user = await dbRun(
      `INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, 'student')`,
      [username, name, password || 'password'],
    );
    const student = await dbRun(
      `INSERT INTO students (user_id, roll_number, class_id) VALUES (?, ?, ?)`,
      [
        user.lastID,
        req.body.rollNumber || req.body.roll_number || null,
        classId,
      ],
    );

    if (faceDescriptor) {
      await saveDescriptor(student.lastID, faceDescriptor);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(err.code === 'SQLITE_CONSTRAINT' ? 400 : 500).json({
      ok: false,
      error:
        err.code === 'SQLITE_CONSTRAINT'
          ? 'student_conflict'
          : 'database_error',
    });
  }
});

router.put('/:username', async (req, res) => {
  const { username } = req.params;
  const { name, password, faceDescriptor } = req.body;

  try {
    const student = await dbGet(
      `SELECT students.id, students.class_id, users.id AS user_id FROM students JOIN users ON users.id = students.user_id WHERE users.username = ? AND users.role = 'student'`,
      [username],
    );
    if (!student)
      return res.status(404).json({ ok: false, error: 'not_found' });

    const hasClassChange =
      req.body.classId !== undefined ||
      req.body.class_id !== undefined ||
      req.body.courseId !== undefined ||
      req.body.branchId !== undefined ||
      req.body.semester !== undefined ||
      req.body.sectionId !== undefined ||
      req.body.section !== undefined;
    const classId = hasClassChange
      ? await resolveClassId(req.body)
      : student.class_id;
    if (!classId)
      return res.status(400).json({ ok: false, error: 'invalid_class' });

    await dbRun(
      `UPDATE users SET name = ?, password = COALESCE(?, password) WHERE id = ?`,
      [name || null, password || null, student.user_id],
    );
    if (classId !== student.class_id) {
      await dbRun(`UPDATE students SET class_id = ? WHERE id = ?`, [
        classId,
        student.id,
      ]);
    }
    if (faceDescriptor) await saveDescriptor(student.id, faceDescriptor);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(err.code === 'SQLITE_CONSTRAINT' ? 400 : 500).json({
      ok: false,
      error:
        err.code === 'SQLITE_CONSTRAINT'
          ? 'student_conflict'
          : 'database_error',
    });
  }
});

router.delete('/:studentId', async (req, res) => {
  try {
    const student = await dbGet(
      `SELECT students.id, users.id AS user_id FROM students JOIN users ON users.id = students.user_id WHERE users.username = ? AND users.role = 'student'`,
      [req.params.studentId],
    );
    if (!student)
      return res.status(404).json({ ok: false, error: 'not_found' });

    await dbRun(`DELETE FROM attendance WHERE student_id = ?`, [student.id]);
    await dbRun(`DELETE FROM face_descriptors WHERE student_id = ?`, [
      student.id,
    ]);
    await dbRun(`DELETE FROM students WHERE id = ?`, [student.id]);
    await dbRun(`DELETE FROM users WHERE id = ?`, [student.user_id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

function resolveClassId(data) {
  if (data.classId || data.class_id) {
    return dbGet(`SELECT id FROM classes WHERE id = ?`, [
      data.classId || data.class_id,
    ]).then(row => row?.id);
  }

  const conditions = [];
  const params = [];
  if (data.courseId) {
    conditions.push('classes.course_id = ?');
    params.push(data.courseId);
  }
  if (data.branchId) {
    conditions.push('classes.branch_id = ?');
    params.push(data.branchId);
  }
  if (data.semester) {
    conditions.push('classes.semester = ?');
    params.push(data.semester);
  }
  if (data.sectionId) {
    conditions.push('classes.section_id = ?');
    params.push(data.sectionId);
  } else if (data.section) {
    conditions.push('(sections.label = ? OR sections.name = ?)');
    params.push(data.section, data.section);
  } else {
    return Promise.resolve(null);
  }

  return dbAll(
    `SELECT classes.id FROM classes JOIN sections ON sections.id = classes.section_id WHERE ${conditions.join(' AND ')} ORDER BY classes.id`,
    params,
  ).then(rows => (rows.length === 1 ? rows[0].id : null));
}

function saveDescriptor(studentId, descriptor) {
  return dbRun(
    `INSERT INTO face_descriptors (student_id, descriptor) VALUES (?, ?) ON CONFLICT(student_id) DO UPDATE SET descriptor = excluded.descriptor`,
    [
      studentId,
      typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor),
    ],
  );
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

export default router;
