import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_DIR = path.resolve(__dirname, '../gallery');

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
        students.roll_number AS rollNumber,
        students.class_id AS classId,
        curriculum.course_id AS courseId,
        curriculum.branch_id AS branchId,
        curriculum.semester,
        sections.label AS section
      FROM users
      JOIN students ON students.user_id = users.id
      JOIN classes ON classes.id = students.class_id
      JOIN curriculum on curriculum.id = classes.curriculum_id
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

router.get('/meta', async (req, res) => {
  try {
    const [courses, branches, classes] = await Promise.all([
      dbAll(`SELECT id, abbr AS label FROM courses ORDER BY abbr`),
      dbAll(`SELECT id, abbr AS label FROM branches ORDER BY abbr`),
      dbAll(`
        SELECT classes.id, curriculum.course_id, curriculum.branch_id, curriculum.semester,
          sections.label AS section
        FROM classes
        JOIN sections ON sections.id = classes.section_id
        JOIN curriculum on curriculum.id = classes.curriculum_id
        ORDER BY curriculum.course_id, curriculum.branch_id, curriculum.semester, classes.id
      `),
    ]);
    return res.json({ courses, branches, classes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.get('/username-available', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) return res.json({ available: false });

  try {
    const existing = await dbGet(`SELECT id FROM users WHERE username = ?`, [
      username,
    ]);
    return res.json({ available: !existing });
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
    SELECT DISTINCT students.id AS id, users.username, users.name,
      students.roll_number AS roll_number
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
  const username = String(req.body.username || '').trim();
  const name = String(req.body.name || '').trim();
  const { password, faceDescriptor } = req.body;
  let galleryPath;
  let transactionStarted = false;

  try {
    const classId = await resolveClassId(req.body);
    const rollNumber = String(req.body.rollNumber || '').trim();
    const semester = Number(req.body.semester);
    const uploadedImages = Array.isArray(req.body.faceImages)
      ? req.body.faceImages.map(decodeUploadedImage)
      : [];
    if (
      !username ||
      !name ||
      !rollNumber ||
      !Number.isInteger(semester) ||
      semester < 1 ||
      semester > 8 ||
      !classId
    )
      return res.status(400).json({ ok: false, error: 'invalid_student_data' });
    if (
      !uploadedImages.length ||
      uploadedImages.length > 20 ||
      uploadedImages.includes(null)
    )
      return res.status(400).json({ ok: false, error: 'face_images_required' });

    const existing = await dbGet(`SELECT id FROM users WHERE username = ?`, [
      username,
    ]);
    if (existing)
      return res.status(409).json({ ok: false, error: 'username_taken' });

    await dbRun('BEGIN TRANSACTION');
    transactionStarted = true;
    const user = await dbRun(
      `INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, 'student')`,
      [username, name, password || 'password'],
    );
    const student = await dbRun(
      `INSERT INTO students (user_id, roll_number, class_id) VALUES (?, ?, ?)`,
      [user.lastID, rollNumber, classId],
    );

    const safeUsername = safePathPart(username);
    const safeRollNumber = safePathPart(rollNumber);
    const galleryFolder = `${student.lastID}_${safeUsername}_${safeRollNumber}`;
    galleryPath = path.join(GALLERY_DIR, galleryFolder);
    await fs.mkdir(galleryPath, { recursive: true });
    await Promise.all(
      uploadedImages.map((image, index) =>
        fs.writeFile(
          path.join(galleryPath, `image_${index + 1}${image.extension}`),
          image.buffer,
        ),
      ),
    );

    if (faceDescriptor) {
      await saveDescriptor(student.lastID, faceDescriptor);
    }
    await dbRun('COMMIT');
    transactionStarted = false;
    return res.json({
      success: true,
      studentId: student.lastID,
      galleryFolder,
    });
  } catch (err) {
    if (transactionStarted) {
      try {
        await dbRun('ROLLBACK');
      } catch (rollbackError) {
        console.error(rollbackError);
      }
    }
    if (galleryPath) await fs.rm(galleryPath, { recursive: true, force: true });
    console.error(err);
    return res.status(err.code === 'SQLITE_CONSTRAINT' ? 409 : 500).json({
      ok: false,
      error:
        err.code === 'SQLITE_CONSTRAINT' ? 'username_taken' : 'database_error',
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
    if (req.body.rollNumber !== undefined) {
      await dbRun(`UPDATE students SET roll_number = ? WHERE id = ?`, [
        String(req.body.rollNumber).trim(),
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
  if (data.courseId && data.branchId && data.semester && data.classId) {
    return dbGet(
      `SELECT id FROM classes WHERE id = ? AND course_id = ? AND branch_id = ? AND semester = ?`,
      [data.classId, data.courseId, data.branchId, data.semester],
    ).then(row => row?.id);
  }
  if (data.classId || data.class_id) {
    return dbGet(`SELECT id FROM classes WHERE id = ?`, [
      data.classId || data.class_id,
    ]).then(row => row?.id);
  }

  const conditions = [];
  const params = [];
  if (data.courseId) {
    conditions.push('curriculum.course_id = ?');
    params.push(data.courseId);
  }
  if (data.branchId) {
    conditions.push('curriculum.branch_id = ?');
    params.push(data.branchId);
  }
  if (data.semester) {
    conditions.push('curriculum.semester = ?');
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

function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function imageExtension(mimetype) {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  return extensions[mimetype] || '.img';
}

function decodeUploadedImage(image) {
  if (!image || typeof image.dataUrl !== 'string') return null;
  const match = image.dataUrl.match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) return null;
  return { buffer, extension: imageExtension(match[1]) };
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
