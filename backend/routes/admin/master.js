import express from 'express';
import { dbAll, dbGet, dbRun, withTransaction } from '../../utils/db.js';
import { todayLocal } from '../../utils/dates.js';
import { HttpError, wrap, clean, makeUniqueAbbr, generatePassword, checkPassword, checkEmail, checkPhone, checkUsername, YEAR_MIN, yearMax } from './common.js';

const router = express.Router();
const SECTIONS = ['A', 'B', 'C', 'D', 'E'];
const ROOM_TYPES = ['classroom', 'seminar_hall', 'lab'];

const text = (name, label, extra = {}) => ({ name, label, type: 'text', required: true, ...extra });
const opt = (name, label, extra = {}) => text(name, label, { required: false, ...extra });

// One entry per Setup tab. `fields` drive both the add/edit form and server validation.
const ENTITIES = {
  students: {
    label: 'Students',
    singular: 'student',
    table: 'students',
    columns: [['name', 'Name'], ['roll_number', 'Roll no.'], ['username', 'Username'], ['classLabel', 'Class'], ['batch', 'Batch'], ['status', 'Status']],
    fields: [
      text('name', 'Full name'),
      text('roll_number', 'Roll number'),
      text('username', 'Username'),
      { name: 'password', label: 'Password', type: 'password', secret: true, hint: 'Leave blank to keep the current one (new students get a generated password).' },
      opt('college_email', 'College email', { type: 'email' }),
      opt('phone_number', 'Phone', { type: 'tel' }),
      text('year_of_passing', 'Year of passing', { type: 'number', min: YEAR_MIN, max: yearMax() }),
      { name: 'class_id', label: 'Class', type: 'select', ref: 'classes', virtual: true, required: false },
      opt('batch', 'Batch', { virtual: true, hint: 'e.g. G1, G2' }),
      { name: 'active', label: 'Active', type: 'checkbox', default: 1 },
    ],
    list: `
      SELECT s.id, s.name, s.roll_number, s.username, s.college_email, s.phone_number,
             s.year_of_passing, s.active, sm.class_id, sm.batch,
             CASE WHEN c.id IS NULL THEN '' ELSE b.abbr || ' Sem ' || c.semester || ' ' || c.section END AS classLabel,
             CASE WHEN s.active = 1 THEN 'Active' ELSE 'Inactive' END AS status
      FROM students s
      LEFT JOIN students_mapping sm ON sm.id = (
        SELECT sm2.id FROM students_mapping sm2 JOIN classes c2 ON c2.id = sm2.class_id
        WHERE sm2.student_id = s.id
        ORDER BY c2.academic_session DESC, c2.semester DESC, sm2.id DESC LIMIT 1)
      LEFT JOIN classes c ON c.id = sm.class_id
      LEFT JOIN branches b ON b.id = c.branch_id
      ORDER BY s.name`,
  },
  faculties: {
    label: 'Faculty',
    singular: 'faculty member',
    table: 'faculties',
    columns: [['name', 'Name'], ['abbr', 'Abbr'], ['username', 'Username'], ['periods', 'Periods / week']],
    fields: [
      text('name', 'Full name'),
      opt('abbr', 'Abbreviation', { hint: 'Leave blank to generate one from the name.' }),
      text('username', 'Username'),
      { name: 'password', label: 'Password', type: 'password', secret: true, hint: 'Leave blank to keep the current one (new faculty get a generated password).' },
    ],
    list: `SELECT f.id, f.name, f.abbr, f.username,
             (SELECT COUNT(*) FROM timetable t WHERE t.faculty_id = f.id
                AND (t.valid_to IS NULL OR t.valid_to >= date('now'))) AS periods
           FROM faculties f ORDER BY f.name`,
  },
  subjects: {
    label: 'Subjects',
    singular: 'subject',
    table: 'subjects',
    columns: [['code', 'Code'], ['name', 'Name'], ['abbr', 'Abbr'], ['attendance', 'Attendance']],
    fields: [
      text('code', 'Code'),
      text('name', 'Name'),
      text('abbr', 'Abbreviation'),
      { name: 'takes_attendance', label: 'Takes attendance', type: 'checkbox', default: 1, hint: 'Untick for Training, Project, Placement prep etc.' },
    ],
    list: `SELECT id, code, name, abbr, takes_attendance,
             CASE takes_attendance WHEN 1 THEN 'Yes' ELSE 'No' END AS attendance
           FROM subjects ORDER BY code`,
  },
  classes: {
    label: 'Classes',
    singular: 'class',
    table: 'classes',
    columns: [['branch', 'Branch'], ['semester', 'Sem'], ['section', 'Section'], ['academic_session', 'Session'], ['room', 'Home room'], ['counsellor', 'Class counsellor'], ['students', 'Students']],
    fields: [
      { name: 'branch_id', label: 'Branch', type: 'select', ref: 'branches', required: true },
      text('semester', 'Semester', { type: 'number', min: 1, max: 8 }),
      { name: 'section', label: 'Section', type: 'select', options: SECTIONS, required: true },
      text('academic_session', 'Academic session', { hint: 'e.g. 2026-2027 ODD' }),
      { name: 'room_id', label: 'Home room', type: 'select', ref: 'rooms', required: false },
      opt('counsellor', 'Class counsellor', { hint: 'Printed on the timetable sheet.' }),
    ],
    list: `SELECT c.id, c.branch_id, c.semester, c.section, c.academic_session, c.room_id, COALESCE(c.counsellor, '') AS counsellor,
             b.abbr AS branch, COALESCE(r.block || '-' || r.number, '') AS room,
             (SELECT COUNT(*) FROM students_mapping sm JOIN students s ON s.id = sm.student_id
               WHERE sm.class_id = c.id AND s.active = 1) AS students
           FROM classes c JOIN branches b ON b.id = c.branch_id LEFT JOIN rooms r ON r.id = c.room_id
           ORDER BY c.academic_session DESC, b.abbr, c.semester, c.section`,
  },
  branches: {
    label: 'Branches',
    singular: 'branch',
    table: 'branches',
    columns: [['course', 'Course'], ['name', 'Name'], ['abbr', 'Abbr']],
    fields: [
      { name: 'course_id', label: 'Course', type: 'select', ref: 'courses', required: true },
      text('name', 'Name'),
      text('abbr', 'Abbreviation'),
    ],
    list: `SELECT b.id, b.course_id, b.name, b.abbr, c.abbr AS course
           FROM branches b JOIN courses c ON c.id = b.course_id ORDER BY c.abbr, b.name`,
  },
  courses: {
    label: 'Courses',
    singular: 'course',
    table: 'courses',
    columns: [['name', 'Name'], ['abbr', 'Abbr']],
    fields: [text('name', 'Name'), text('abbr', 'Abbreviation')],
    list: `SELECT id, name, abbr FROM courses ORDER BY name`,
  },
  rooms: {
    label: 'Rooms',
    singular: 'room',
    table: 'rooms',
    columns: [['block', 'Block'], ['number', 'Number'], ['type', 'Type'], ['camera_url', 'Camera URL']],
    fields: [
      text('block', 'Block'),
      text('number', 'Number'),
      { name: 'type', label: 'Type', type: 'select', options: ROOM_TYPES, required: true },
      opt('camera_url', 'Camera URL'),
    ],
    list: `SELECT id, block, number, type, COALESCE(camera_url, '') AS camera_url FROM rooms ORDER BY block, number`,
  },
  slots: {
    label: 'Periods',
    singular: 'period',
    table: 'slots',
    columns: [['label', 'Label'], ['start_time', 'Start'], ['end_time', 'End']],
    fields: [
      text('label', 'Label', { hint: 'e.g. Period 1' }),
      text('start_time', 'Start time', { type: 'time' }),
      text('end_time', 'End time', { type: 'time' }),
    ],
    list: `SELECT id, label, start_time, end_time FROM slots ORDER BY start_time`,
  },
};

async function refOptions(ref) {
  const queries = {
    courses: `SELECT id AS value, abbr AS label FROM courses ORDER BY abbr`,
    branches: `SELECT b.id AS value, c.abbr || ' / ' || b.abbr AS label FROM branches b JOIN courses c ON c.id = b.course_id ORDER BY c.abbr, b.abbr`,
    rooms: `SELECT id AS value, block || '-' || number AS label FROM rooms ORDER BY block, number`,
    classes: `SELECT c.id AS value, b.abbr || ' Sem ' || c.semester || ' ' || c.section || ' (' || c.academic_session || ')' AS label
              FROM classes c JOIN branches b ON b.id = c.branch_id
              ORDER BY c.academic_session DESC, b.abbr, c.semester, c.section`,
  };
  return dbAll(queries[ref]);
}

router.get('/meta', wrap(async (req, res) => {
  const refs = {};
  for (const ref of ['courses', 'branches', 'rooms', 'classes']) refs[ref] = await refOptions(ref);
  const entities = {};
  for (const [key, e] of Object.entries(ENTITIES)) {
    entities[key] = {
      label: e.label,
      singular: e.singular,
      columns: e.columns,
      fields: e.fields.map(f => ({ ...f, options: f.ref ? refs[f.ref] : f.options?.map(v => ({ value: v, label: v })) })),
    };
  }
  const sessions = (await dbAll(`SELECT DISTINCT academic_session AS s FROM classes ORDER BY s DESC`)).map(r => r.s);
  res.json({ ok: true, entities, sessions, today: todayLocal() });
}));

function entityOr404(name) {
  const entity = ENTITIES[name];
  if (!entity) throw new HttpError(404, 'unknown_entity', 'Unknown table.');
  return entity;
}

router.get('/entity/:name', wrap(async (req, res) => {
  const entity = entityOr404(req.params.name);
  res.json({ ok: true, rows: await dbAll(entity.list) });
}));

function buildValues(entity, body, isInsert, out = {}) {
  const values = {};
  for (const f of entity.fields) {
    if (f.virtual) continue;
    let v = body[f.name];
    if (f.secret) {
      v = clean(v);
      if (!v) {
        if (!isInsert) continue;
        v = out.generatedPassword = generatePassword(); // handed to the admin once, never "password"
      } else checkPassword(v);
      values[f.name] = v;
      continue;
    }
    if (f.type === 'checkbox') {
      if (v === undefined && !isInsert) continue;
      values[f.name] = v === undefined ? (f.default ?? 0) : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
      continue;
    }
    if (v === undefined && !isInsert) continue;
    v = clean(v);
    if (v === null) {
      if (f.required) throw new HttpError(400, 'required_value_missing', `${f.label} is required.`);
      values[f.name] = null;
      continue;
    }
    if (f.type === 'email') checkEmail(v);
    if (f.type === 'tel') checkPhone(v);
    if (f.name === 'username') checkUsername(v);
    if (f.type === 'number' || f.ref) {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new HttpError(400, 'invalid_value', `${f.label} must be a whole number.`);
      if (f.min && n < f.min || f.max && n > f.max) throw new HttpError(400, 'invalid_value', `${f.label} must be between ${f.min} and ${f.max}.`);
      values[f.name] = n;
    } else if (f.type === 'select' && !f.ref && !f.options.includes(v)) {
      throw new HttpError(400, 'invalid_value', `${f.label} is not one of the allowed values.`);
    } else if (f.type === 'time' && !/^[0-2]\d:[0-5]\d$/.test(v)) {
      throw new HttpError(400, 'invalid_value', `${f.label} must look like 09:30.`);
    } else values[f.name] = v;
  }
  return values;
}

async function syncStudentMapping(studentId, body) {
  const classId = Number(clean(body.class_id));
  if (!classId) return;
  if (!(await dbGet(`SELECT 1 AS x FROM classes WHERE id = ?`, [classId])))
    throw new HttpError(400, 'invalid_reference', 'That class does not exist.');
  const batch = clean(body.batch);
  const existing = await dbGet(`SELECT id FROM students_mapping WHERE student_id = ? AND class_id = ?`, [studentId, classId]);
  if (existing) await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [batch, existing.id]);
  else await dbRun(`INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`, [studentId, classId, batch]);
}

router.post('/entity/:name', wrap(async (req, res) => {
  const entity = entityOr404(req.params.name);
  const out = {};
  const values = buildValues(entity, req.body || {}, true, out);
  if (entity.table === 'faculties' && !values.abbr) values.abbr = await makeUniqueAbbr(values.name);
  const id = await withTransaction(async () => {
    const names = Object.keys(values);
    const result = await dbRun(
      `INSERT INTO ${entity.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      names.map(n => values[n]),
    );
    if (entity.table === 'students') await syncStudentMapping(result.lastID, req.body);
    return result.lastID;
  });
  res.status(201).json({ ok: true, id, ...(out.generatedPassword ? { generatedPassword: out.generatedPassword } : {}) });
}));

router.put('/entity/:name/:id', wrap(async (req, res) => {
  const entity = entityOr404(req.params.name);
  const row = await dbGet(`SELECT id FROM ${entity.table} WHERE id = ?`, [req.params.id]);
  if (!row) throw new HttpError(404, 'not_found', 'That record no longer exists.');
  const values = buildValues(entity, req.body || {}, false);
  if (entity.table === 'faculties' && values.abbr === null) delete values.abbr;
  await withTransaction(async () => {
    const names = Object.keys(values);
    if (names.length)
      await dbRun(`UPDATE ${entity.table} SET ${names.map(n => `${n} = ?`).join(', ')} WHERE id = ?`, [...names.map(n => values[n]), row.id]);
    if (entity.table === 'students') await syncStudentMapping(row.id, req.body);
  });
  res.json({ ok: true });
}));

router.delete('/entity/:name/:id', wrap(async (req, res) => {
  const entity = entityOr404(req.params.name);
  if (entity.table === 'students') {
    // Students keep their attendance history, so "delete" only deactivates.
    await dbRun(`UPDATE students SET active = 0 WHERE id = ?`, [req.params.id]);
    return res.json({ ok: true, deactivated: true });
  }
  const result = await dbRun(`DELETE FROM ${entity.table} WHERE id = ?`, [req.params.id]);
  if (!result.changes) throw new HttpError(404, 'not_found', 'That record no longer exists.');
  res.json({ ok: true });
}));

// ---------------- Term setup ----------------
router.post('/term-setup', wrap(async (req, res) => {
  const session = clean(req.body?.session);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!session) throw new HttpError(400, 'invalid_session', 'Enter the academic session, e.g. 2026-2027 ODD.');
  if (!items.length) throw new HttpError(400, 'nothing_to_create', 'Add at least one branch and semester.');
  let created = 0;
  let existing = 0;
  await withTransaction(async () => {
    for (const item of items) {
      const branchId = Number(item.branchId);
      const semester = Number(item.semester);
      if (!(await dbGet(`SELECT 1 AS x FROM branches WHERE id = ?`, [branchId])))
        throw new HttpError(400, 'invalid_reference', 'Choose a branch for every row.');
      if (!Number.isInteger(semester) || semester < 1 || semester > 8)
        throw new HttpError(400, 'invalid_value', 'Semester must be 1 to 8.');
      const roomId = Number(item.roomId) || null;
      for (const section of item.sections || []) {
        if (!SECTIONS.includes(section)) throw new HttpError(400, 'invalid_value', 'Unknown section.');
        const result = await dbRun(
          `INSERT OR IGNORE INTO classes (branch_id, semester, room_id, section, academic_session) VALUES (?, ?, ?, ?, ?)`,
          [branchId, semester, roomId, section, session],
        );
        if (result.changes) created++;
        else existing++;
      }
    }
  });
  res.json({ ok: true, created, existing });
}));

// Split each class's active students (by roll number) into G1 / G2 for every class that has lab batches
// in its timetable. Only fills students who have no batch yet unless ?overwrite=1.
router.post('/assign-batches', wrap(async (req, res) => {
  const session = clean(req.body.session);
  const overwrite = Boolean(req.body.overwrite);
  const classes = await dbAll(
    `SELECT c.id FROM classes c WHERE c.academic_session = ?
       AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = c.id AND x.batch IS NOT NULL)`, [session]);
  let updated = 0;
  await withTransaction(async () => {
    for (const { id } of classes) {
      const students = await dbAll(
        `SELECT sm.id, sm.batch FROM students_mapping sm JOIN students s ON s.id = sm.student_id AND s.active = 1
          WHERE sm.class_id = ? ORDER BY s.roll_number, s.name`, [id]);
      const half = Math.ceil(students.length / 2);
      for (const [i, st] of students.entries()) {
        if (st.batch && !overwrite) continue;
        await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [i < half ? 'G1' : 'G2', st.id]);
        updated++;
      }
    }
  });
  res.json({ ok: true, updated, classes: classes.length });
}));

router.get('/term-status', wrap(async (req, res) => {
  const session = clean(req.query.session);
  const today = todayLocal();
  const status = await dbGet(
    `SELECT
       (SELECT COUNT(*) FROM classes WHERE academic_session = ?) AS classes,
       (SELECT COUNT(DISTINCT sm.student_id) FROM students_mapping sm
          JOIN classes c ON c.id = sm.class_id JOIN students s ON s.id = sm.student_id AND s.active = 1
         WHERE c.academic_session = ?) AS students,
       (SELECT COUNT(DISTINCT tc.class_id) FROM timetable_classes tc
          JOIN classes c ON c.id = tc.class_id JOIN timetable t ON t.id = tc.timetable_id
         WHERE c.academic_session = ? AND (t.valid_to IS NULL OR t.valid_to >= ?)) AS classesWithTimetable,
       (SELECT COUNT(*) FROM students_mapping sm
          JOIN classes c ON c.id = sm.class_id JOIN students s ON s.id = sm.student_id AND s.active = 1
         WHERE c.academic_session = ? AND sm.batch IS NOT NULL
           AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = c.id AND x.batch IS NOT NULL)) AS batchAssigned,
       (SELECT COUNT(*) FROM students_mapping sm
          JOIN classes c ON c.id = sm.class_id JOIN students s ON s.id = sm.student_id AND s.active = 1
         WHERE c.academic_session = ?
           AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = c.id AND x.batch IS NOT NULL)) AS batchNeeded,
       (SELECT COUNT(*) FROM subjects) AS subjects,
       (SELECT COUNT(*) FROM faculties) AS faculty,
       (SELECT COUNT(*) FROM rooms) AS rooms,
       (SELECT COUNT(*) FROM slots) AS slots,
       (SELECT COUNT(*) FROM branches) AS branches`,
    [session, session, session, today, session, session],
  );
  res.json({ ok: true, session, ...status });
}));

export default router;
