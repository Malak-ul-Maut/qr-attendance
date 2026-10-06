import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbAll, dbGet, dbRun, withTransaction } from '../utils/db.js';
import { galleryFolderName } from '../utils/gallery.js';
import { getSessionStudents } from '../utils/timetable.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_DIR = path.resolve(__dirname, '../gallery');

// A student can be mapped to several classes over time (one row per class).
// The admin list shows the newest one: latest academic session, then highest semester.
const CURRENT_MAPPING_JOIN = `
  LEFT JOIN students_mapping
    ON students_mapping.id = (
      SELECT sm.id
      FROM students_mapping sm
      JOIN classes c ON c.id = sm.class_id
      WHERE sm.student_id = students.id
      ORDER BY c.academic_session DESC, c.semester DESC, sm.id DESC
      LIMIT 1
    )
  LEFT JOIN classes ON classes.id = students_mapping.class_id
  LEFT JOIN branches ON branches.id = classes.branch_id
`;

// Students list. Inactive (soft-deleted) students are hidden unless ?includeInactive=1.
router.get('/', async (req, res) => {
  const includeInactive = req.query.includeInactive === '1';
  try {
    const rows = await dbAll(`
      SELECT
        students.username,
        students.name,
        students.password_hash AS password,
        students.roll_number AS rollNumber,
        students.college_email AS collegeEmail,
        students.phone_number AS phoneNumber,
        students.year_of_passing AS yearOfPassing,
        students.active,
        students_mapping.class_id AS classId,
        students_mapping.batch,
        branches.course_id AS courseId,
        classes.branch_id AS branchId,
        classes.semester,
        classes.section
      FROM students
      ${CURRENT_MAPPING_JOIN}
      ${includeInactive ? '' : 'WHERE students.active = 1'}
      ORDER BY students.name
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
      dbAll(
        `SELECT id, abbr AS label, course_id FROM branches ORDER BY abbr`,
      ),
      dbAll(`
        SELECT classes.id, branches.course_id, classes.branch_id, classes.semester,
          classes.section, classes.academic_session
        FROM classes
        JOIN branches ON branches.id = classes.branch_id
        ORDER BY branches.course_id, classes.branch_id, classes.semester, classes.id
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
    // students.username is case-insensitive in the database, and so is this check.
    const existing = await dbGet(`SELECT id FROM students WHERE username = ?`, [
      username,
    ]);
    return res.json({ available: !existing });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// The student's saved face template, as a plain array of numbers.
router.get('/descriptors', async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT face_embedding FROM students WHERE username = ? AND active = 1`,
      [req.query.id],
    );
    if (!row?.face_embedding)
      return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json(decodeEmbedding(row.face_embedding));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// The students of a session (everyone it was opened for).
router.get('/:sessionCode', async (req, res) => {
  try {
    const rows = await getSessionStudents(req.params.sessionCode);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
});

router.post('/', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const name = String(req.body.name || '').trim();
  const { password, faceDescriptor } = req.body;
  let galleryPath;

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

    let embedding = null;
    if (faceDescriptor) {
      embedding = encodeEmbedding(faceDescriptor);
      if (!embedding)
        return res
          .status(400)
          .json({ ok: false, error: 'invalid_face_descriptor' });
    }

    // year_of_passing is required by the database. Use the one in the request, or the
    // one the rest of this class already has.
    const yearOfPassing = await resolveYearOfPassing(req.body, classId);
    if (!yearOfPassing)
      return res
        .status(400)
        .json({ ok: false, error: 'year_of_passing_required' });

    const existing = await dbGet(`SELECT id FROM students WHERE username = ?`, [
      username,
    ]);
    if (existing)
      return res.status(409).json({ ok: false, error: 'username_taken' });

    const created = await withTransaction(async () => {
      const student = await dbRun(
        `INSERT INTO students
           (name, roll_number, college_email, phone_number, year_of_passing,
            face_embedding, username, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          rollNumber,
          optionalText(req.body.collegeEmail),
          optionalText(req.body.phoneNumber),
          yearOfPassing,
          embedding,
          username,
          password || 'password',
        ],
      );
      await dbRun(
        `INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`,
        [student.lastID, classId, optionalText(req.body.batch)],
      );

      const galleryFolder = galleryFolderName({
        id: student.lastID,
        username,
        roll_number: rollNumber,
      });
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
      return { id: student.lastID, galleryFolder };
    });

    return res.json({
      success: true,
      studentId: created.id,
      galleryFolder: created.galleryFolder,
    });
  } catch (err) {
    if (galleryPath) await fs.rm(galleryPath, { recursive: true, force: true });
    console.error(err);
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ ok: false, error: conflictName(err) });
    }
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.put('/:username', async (req, res) => {
  const { username } = req.params;
  const { name, password, faceDescriptor } = req.body;

  try {
    const student = await dbGet(`SELECT id FROM students WHERE username = ?`, [
      username,
    ]);
    if (!student)
      return res.status(404).json({ ok: false, error: 'not_found' });

    const hasClassChange =
      req.body.classId !== undefined ||
      req.body.class_id !== undefined ||
      req.body.courseId !== undefined ||
      req.body.branchId !== undefined ||
      req.body.semester !== undefined ||
      req.body.section !== undefined;
    let classId = null;
    if (hasClassChange) {
      classId = await resolveClassId(req.body);
      if (!classId)
        return res.status(400).json({ ok: false, error: 'invalid_class' });
    }

    let embedding = null;
    if (faceDescriptor) {
      embedding = encodeEmbedding(faceDescriptor);
      if (!embedding)
        return res
          .status(400)
          .json({ ok: false, error: 'invalid_face_descriptor' });
    }

    await withTransaction(async () => {
      await dbRun(
        `UPDATE students SET
           name = COALESCE(?, name),
           password_hash = COALESCE(?, password_hash),
           roll_number = COALESCE(?, roll_number),
           college_email = CASE WHEN ? THEN ? ELSE college_email END,
           phone_number = CASE WHEN ? THEN ? ELSE phone_number END,
           year_of_passing = COALESCE(?, year_of_passing),
           face_embedding = COALESCE(?, face_embedding),
           active = COALESCE(?, active)
         WHERE id = ?`,
        [
          name || null,
          password || null,
          req.body.rollNumber !== undefined
            ? String(req.body.rollNumber).trim() || null
            : null,
          req.body.collegeEmail !== undefined ? 1 : 0,
          optionalText(req.body.collegeEmail),
          req.body.phoneNumber !== undefined ? 1 : 0,
          optionalText(req.body.phoneNumber),
          Number.isInteger(Number(req.body.yearOfPassing))
            ? Number(req.body.yearOfPassing)
            : null,
          embedding,
          req.body.active === undefined ? null : req.body.active ? 1 : 0,
          student.id,
        ],
      );

      if (classId || req.body.batch !== undefined) {
        const current = await dbGet(
          `
          SELECT students_mapping.id, students_mapping.class_id
          FROM students_mapping
          JOIN classes ON classes.id = students_mapping.class_id
          WHERE students_mapping.student_id = ?
          ORDER BY classes.academic_session DESC, classes.semester DESC,
            students_mapping.id DESC
          LIMIT 1
          `,
          [student.id],
        );
        const batch =
          req.body.batch !== undefined ? optionalText(req.body.batch) : undefined;

        if (!current) {
          if (classId)
            await dbRun(
              `INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`,
              [student.id, classId, batch ?? null],
            );
        } else {
          await dbRun(
            `UPDATE students_mapping SET
               class_id = ?,
               batch = CASE WHEN ? THEN ? ELSE batch END
             WHERE id = ?`,
            [
              classId || current.class_id,
              batch === undefined ? 0 : 1,
              batch ?? null,
              current.id,
            ],
          );
        }
      }
    });
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ ok: false, error: conflictName(err) });
    }
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// "Delete" = make the student inactive. The row, class mapping, face data and past
// attendance all stay, so history is kept and the student can be switched back on.
router.delete('/:username', async (req, res) => {
  try {
    const student = await dbGet(`SELECT id FROM students WHERE username = ?`, [
      req.params.username,
    ]);
    if (!student)
      return res.status(404).json({ ok: false, error: 'not_found' });

    await dbRun(`UPDATE students SET active = 0 WHERE id = ?`, [student.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

// Which class does the request mean? Either an exact classId (checked against the
// course/branch/semester when those are sent too), or course + branch + semester + section.
async function resolveClassId(data) {
  const classId = data.classId || data.class_id;

  if (classId && data.courseId && data.branchId && data.semester) {
    const row = await dbGet(
      `SELECT classes.id FROM classes
       JOIN branches ON branches.id = classes.branch_id
       WHERE classes.id = ? AND branches.course_id = ?
         AND classes.branch_id = ? AND classes.semester = ?`,
      [classId, data.courseId, data.branchId, data.semester],
    );
    return row?.id;
  }
  if (classId) {
    const row = await dbGet(`SELECT id FROM classes WHERE id = ?`, [classId]);
    return row?.id;
  }

  if (!data.section) return null;
  const conditions = ['classes.section = ?'];
  const params = [data.section];
  if (data.courseId) {
    conditions.push('branches.course_id = ?');
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
  const rows = await dbAll(
    `SELECT classes.id FROM classes
     JOIN branches ON branches.id = classes.branch_id
     WHERE ${conditions.join(' AND ')} ORDER BY classes.id`,
    params,
  );
  // Several academic sessions can match; only an unambiguous answer is accepted.
  return rows.length === 1 ? rows[0].id : null;
}

async function resolveYearOfPassing(data, classId) {
  const given = Number(data.yearOfPassing);
  if (Number.isInteger(given) && given > 0) return given;

  const row = await dbGet(
    `
    SELECT students.year_of_passing AS year
    FROM students_mapping
    JOIN students ON students.id = students_mapping.student_id
    WHERE students_mapping.class_id = ?
    GROUP BY students.year_of_passing
    ORDER BY COUNT(*) DESC
    LIMIT 1
    `,
    [classId],
  );
  return row?.year ?? null;
}

// Empty or missing text becomes NULL, which matters for the UNIQUE email/phone columns:
// two empty strings would clash, two NULLs do not.
function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// Which UNIQUE column was hit, so the admin sees a useful message.
function conflictName(err) {
  const message = String(err.message);
  if (message.includes('students.username')) return 'username_taken';
  if (message.includes('students.roll_number')) return 'roll_number_taken';
  if (message.includes('students.college_email')) return 'email_taken';
  if (message.includes('students.phone_number')) return 'phone_taken';
  if (message.includes('students_mapping')) return 'class_already_assigned';
  return 'student_conflict';
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

// ---------------------------------------------------------------------------
// face_embedding is a BLOB holding the descriptor as little-endian float32 numbers
// (512 numbers = 2048 bytes). The app still sends and receives plain number arrays.
// ---------------------------------------------------------------------------
function encodeEmbedding(descriptor) {
  let values = descriptor;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(values) || values.length === 0) return null;
  const numbers = values.map(Number);
  if (numbers.some(value => !Number.isFinite(value))) return null;
  const buffer = Buffer.alloc(numbers.length * 4);
  numbers.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function decodeEmbedding(raw) {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  const values = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    values.push(buffer.readFloatLE(offset));
  }
  return values;
}

export default router;
