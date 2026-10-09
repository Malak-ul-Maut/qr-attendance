import express from 'express';
import { dbAll, dbGet, dbRun, withTransaction } from '../../utils/db.js';
import { todayLocal } from '../../utils/dates.js';
import { HttpError, wrap, clean, passingYearFor, makeUniqueAbbr, generatePassword, checkPassword, checkEmail, checkPhone, checkUsername, YEAR_MIN, yearMax } from './common.js';

const router = express.Router();
const SESSION_RE = /^(\d{4})-(\d{4}) (ODD|EVEN)$/;
// Sections are free text (A, B, 3 ...): stored upper-case, up to 8 letters, numbers, spaces, dashes.
function checkSection(value) {
  const section = String(value ?? '').trim().toUpperCase();
  if (!section) throw new HttpError(400, 'required_value_missing', 'Section is required.');
  if (!/^[A-Z0-9][A-Z0-9 _-]{0,7}$/.test(section)) throw new HttpError(400, 'invalid_value', 'Section can be up to 8 letters or numbers, like A or 3.');
  return section;
}
// The academic session is not typed any more: it comes from the semester (odd = ODD, even = EVEN)
// and the academic year (June starts a new one: Oct 2026 -> 2026-2027).
function deriveSession(semester, existingSession) {
  const kind = Number(semester) % 2 === 1 ? 'ODD' : 'EVEN';
  const kept = SESSION_RE.exec(existingSession || '');
  let start;
  if (kept) start = Number(kept[1]); // editing keeps the class in its own academic year
  else {
    const [y, m] = todayLocal().split('-').map(Number);
    start = m >= 6 ? y : y - 1;
  }
  return `${start}-${start + 1} ${kind}`;
}
const BATCHES = ['G1', 'G2']; // lab groups
const checkBatch = value => {
  if (value !== null && !BATCHES.includes(value)) throw new HttpError(400, 'invalid_value', 'Batch must be G1 or G2.');
  return value;
};
const ROOM_TYPES = ['classroom', 'seminar_hall', 'lab'];

const text = (name, label, extra = {}) => ({ name, label, type: 'text', required: true, ...extra });
const opt = (name, label, extra = {}) => text(name, label, { required: false, ...extra });

// One entry per Setup tab. `fields` drive both the add/edit form and server validation.
const ENTITIES = {
  students: {
    label: 'Students',
    singular: 'student',
    table: 'students',
    columns: [['name', 'Name'], ['roll_number', 'Roll no.'], ['username', 'Username'], ['classLabel', 'Class'], ['batch', 'Batch']],
    fields: [
      text('name', 'Full name'),
      text('roll_number', 'Roll number'),
      text('username', 'Username'),
      { name: 'password', label: 'Password', type: 'password', secret: true, hint: 'Leave blank to keep the current one (new students get a generated password).' },
      opt('college_email', 'College email', { type: 'email' }),
      opt('phone_number', 'Phone', { type: 'tel' }),
      text('year_of_passing', 'Year of passing', { type: 'number', min: YEAR_MIN, max: yearMax() }),
      { name: 'class_id', label: 'Class', type: 'select', ref: 'classes', virtual: true, required: false },
      { name: 'batch', label: 'Batch', type: 'select', options: BATCHES, virtual: true, required: false },
      { name: 'active', label: 'Active', type: 'checkbox', default: 1 },
    ],
    list: `
      SELECT s.id, s.name, s.roll_number, s.username, s.college_email, s.phone_number,
             s.year_of_passing, s.active, sm.class_id, sm.batch,
             CASE WHEN c.id IS NULL THEN '' ELSE b.abbr || ' Sem ' || c.semester || ' ' || c.section END AS classLabel
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
      { name: 'active', label: 'Active', type: 'checkbox', default: 1 },
    ],
    list: `SELECT f.id, f.name, f.abbr, f.username, f.active,
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
      text('section', 'Section', { hint: 'Any short label, e.g. A, B or 3.' }),
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
    columns: [['name', 'Name'], ['abbr', 'Abbr'], ['duration_years', 'Duration (years)']],
    fields: [text('name', 'Name'), text('abbr', 'Abbreviation'), text('duration_years', 'Duration (years)', { type: 'number', min: 1, max: 6, default: 4 })],
    list: `SELECT id, name, abbr, duration_years FROM courses ORDER BY name`,
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
    if (f.name === 'section') { values.section = checkSection(v); continue; }
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
  const batch = checkBatch(clean(body.batch));
  const existing = await dbGet(`SELECT id FROM students_mapping WHERE student_id = ? AND class_id = ?`, [studentId, classId]);
  if (existing) await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [batch, existing.id]);
  else await dbRun(`INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`, [studentId, classId, batch]);
}

router.post('/entity/:name', wrap(async (req, res) => {
  const entity = entityOr404(req.params.name);
  const out = {};
  const values = buildValues(entity, req.body || {}, true, out);
  if (entity.table === 'classes') values.academic_session = deriveSession(values.semester);
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
  const row = await dbGet(`SELECT * FROM ${entity.table} WHERE id = ?`, [req.params.id]);
  if (!row) throw new HttpError(404, 'not_found', 'That record no longer exists.');
  const values = buildValues(entity, req.body || {}, false);
  if (entity.table === 'classes') values.academic_session = deriveSession(values.semester ?? row.semester, row.academic_session);
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
  if (entity.table === 'students' || entity.table === 'faculties') {
    // Students and faculty keep their history (attendance, past timetables), so "delete" only deactivates.
    await dbRun(`UPDATE ${entity.table} SET active = 0 WHERE id = ?`, [req.params.id]);
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
  if (!session) throw new HttpError(400, 'invalid_session', 'Choose the academic session, e.g. 2026-2027 ODD.');
  const known = await dbGet(`SELECT 1 AS x FROM classes WHERE academic_session = ?`, [session]);
  const m = SESSION_RE.exec(session);
  if (!known && (!m || Number(m[2]) !== Number(m[1]) + 1))
    throw new HttpError(400, 'invalid_session', 'Use the format 2026-2027 ODD (two consecutive years, then ODD or EVEN).');
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
        const label = checkSection(section);
        const result = await dbRun(
          `INSERT OR IGNORE INTO classes (branch_id, semester, room_id, section, academic_session) VALUES (?, ?, ?, ?, ?)`,
          [branchId, semester, roomId, label, session],
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
  const classId = Number(req.body.classId) || null;
  const g2Start = Number(req.body.g2StartStudentId) || null; // this student and everyone after them (by roll number) get G2
  const overwrite = Boolean(req.body.overwrite) || Boolean(g2Start);
  const classes = classId
    ? await dbAll(`SELECT c.id FROM classes c WHERE c.id = ? AND c.academic_session = ?`, [classId, session])
    : await dbAll(
      `SELECT c.id FROM classes c WHERE c.academic_session = ?
         AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = c.id AND x.batch IS NOT NULL)`, [session]);
  if (classId && !classes.length) throw new HttpError(404, 'not_found', 'That class is not in this session.');
  let updated = 0;
  await withTransaction(async () => {
    for (const { id } of classes) {
      const students = await dbAll(
        `SELECT sm.id, sm.batch, sm.student_id FROM students_mapping sm JOIN students s ON s.id = sm.student_id AND s.active = 1
          WHERE sm.class_id = ? ORDER BY s.roll_number, s.name`, [id]);
      let split = Math.ceil(students.length / 2);
      if (g2Start) {
        split = students.findIndex(st => st.student_id === g2Start);
        if (split < 0) throw new HttpError(400, 'invalid_value', 'That student is not in this class.');
      }
      for (const [i, st] of students.entries()) {
        if (st.batch && !overwrite) continue;
        await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [i < split ? 'G1' : 'G2', st.id]);
        updated++;
      }
    }
  });
  res.json({ ok: true, updated, classes: classes.length });
}));

// Bulk actions on students: deactivate, reactivate, or move to a class (optionally with a batch).
router.post('/students-bulk', wrap(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))];
  const action = req.body?.action;
  if (!ids.length) throw new HttpError(400, 'invalid_value', 'Select at least one student.');
  if (ids.length > 1000) throw new HttpError(400, 'invalid_value', 'Select at most 1000 students at a time.');
  if (!['deactivate', 'reactivate', 'set_class'].includes(action)) throw new HttpError(400, 'invalid_value', 'Unknown action.');
  const classId = Number(req.body.classId) || null;
  const batch = checkBatch(clean(req.body.batch));
  if (action === 'set_class' && !(await dbGet(`SELECT 1 AS x FROM classes WHERE id = ?`, [classId])))
    throw new HttpError(400, 'invalid_reference', 'Choose a class.');
  await withTransaction(async () => {
    for (const id of ids) {
      if (action === 'set_class') {
        const existing = await dbGet(`SELECT id FROM students_mapping WHERE student_id = ? AND class_id = ?`, [id, classId]);
        if (existing) await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [batch, existing.id]);
        else await dbRun(`INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`, [id, classId, batch]);
      } else await dbRun(`UPDATE students SET active = ? WHERE id = ?`, [action === 'reactivate' ? 1 : 0, id]);
    }
  });
  res.json({ ok: true, updated: ids.length });
}));

// Everything the Term checklist shows for one session.
router.get('/term-status', wrap(async (req, res) => {
  const session = clean(req.query.session);
  const today = todayLocal();
  const one = (sql, params = []) => dbGet(sql, params).then(r => r?.n ?? 0);
  const classes = await dbAll(
    `SELECT c.id, c.semester, c.section, c.room_id, c.branch_id, b.abbr AS branch, co.duration_years
     FROM classes c JOIN branches b ON b.id = c.branch_id JOIN courses co ON co.id = b.course_id
     WHERE c.academic_session = ?`, [session]);
  const classIds = classes.map(c => c.id);
  const inSession = classIds.length ? `(${classIds.join(',')})` : '(NULL)';
  const current = `(t.valid_to IS NULL OR t.valid_to >= '${today}')`;

  // Students who should be in this term (their passing year matches one of its semesters) but are in no class yet
  const years = [...new Set(classes.map(c => passingYearFor(session, c.duration_years, c.semester)))];
  const mapped = await one(
    `SELECT COUNT(DISTINCT sm.student_id) AS n FROM students_mapping sm JOIN students s ON s.id = sm.student_id AND s.active = 1
     WHERE sm.class_id IN ${inSession}`);
  const unassigned = years.length
    ? await one(`SELECT COUNT(*) AS n FROM students s WHERE s.active = 1 AND s.year_of_passing IN (${years.join(',')})
                  AND s.id NOT IN (SELECT student_id FROM students_mapping WHERE class_id IN ${inSession})`)
    : 0;
  const classrooms = new Set(classes.map(c => (c.room_id ? `room${c.room_id}` : `class${c.id}`))).size;
  const batchNeeded = await one(
    `SELECT COUNT(*) AS n FROM students_mapping sm JOIN students s ON s.id = sm.student_id AND s.active = 1
     WHERE sm.class_id IN ${inSession}
       AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = sm.class_id AND x.batch IS NOT NULL)`);
  const batchAssigned = await one(
    `SELECT COUNT(*) AS n FROM students_mapping sm JOIN students s ON s.id = sm.student_id AND s.active = 1
     WHERE sm.class_id IN ${inSession} AND sm.batch IS NOT NULL
       AND EXISTS (SELECT 1 FROM timetable_classes x WHERE x.class_id = sm.class_id AND x.batch IS NOT NULL)`);

  res.json({
    ok: true,
    session,
    classes: classes.length,
    classrooms,
    classesWithoutRoom: classes.filter(c => !c.room_id).length,
    students: mapped,
    unassignedStudents: unassigned,
    classesWithTimetable: await one(
      `SELECT COUNT(DISTINCT tc.class_id) AS n FROM timetable_classes tc JOIN timetable t ON t.id = tc.timetable_id
       WHERE tc.class_id IN ${inSession} AND ${current}`),
    subjects: await one(`SELECT COUNT(*) AS n FROM subjects`),
    subjectsUnscheduled: await one(
      `SELECT COUNT(*) AS n FROM subjects sub WHERE sub.takes_attendance = 1
         AND NOT EXISTS (SELECT 1 FROM timetable t WHERE t.subject_id = sub.id AND ${current})`),
    faculty: await one(`SELECT COUNT(*) AS n FROM faculties WHERE active = 1`),
    facultyIdle: await one(
      `SELECT COUNT(*) AS n FROM faculties f WHERE f.active = 1
         AND NOT EXISTS (SELECT 1 FROM timetable t WHERE t.faculty_id = f.id AND ${current})`),
    withoutFace: await one(
      `SELECT COUNT(DISTINCT s.id) AS n FROM students s JOIN students_mapping sm ON sm.student_id = s.id
       WHERE s.active = 1 AND (s.face_status IS NULL OR s.face_status IN ('none','rejected')) AND sm.class_id IN ${inSession}`),
    pendingReview: await one(
      `SELECT COUNT(DISTINCT s.id) AS n FROM students s JOIN students_mapping sm ON sm.student_id = s.id
       WHERE s.active = 1 AND s.face_status = 'pending' AND sm.class_id IN ${inSession}`),
    batchAssigned,
    batchNeeded,
    rooms: await one(`SELECT COUNT(*) AS n FROM rooms`),
    slots: await one(`SELECT COUNT(*) AS n FROM slots`),
    branches: await one(`SELECT COUNT(*) AS n FROM branches`),
  });
}));

// ---------------- Term wizard: who belongs in a semester, and the final apply ----------------
async function sessionFacts(session, branchId, semester) {
  const m = SESSION_RE.exec(session || '');
  if (!m || Number(m[2]) !== Number(m[1]) + 1) throw new HttpError(400, 'invalid_session', 'Choose a valid academic session first.');
  const branch = await dbGet(
    `SELECT b.id, b.abbr, co.duration_years FROM branches b JOIN courses co ON co.id = b.course_id WHERE b.id = ?`, [branchId]);
  if (!branch) throw new HttpError(400, 'invalid_reference', 'Choose a branch for every row.');
  const sem = Number(semester);
  if (!Number.isInteger(sem) || sem < 1 || sem > branch.duration_years * 2)
    throw new HttpError(400, 'invalid_value', `${branch.abbr} runs ${branch.duration_years} years, so the semester must be 1 to ${branch.duration_years * 2}.`);
  return { branch, sem, passingYear: passingYearFor(session, branch.duration_years, sem) };
}

// Active students whose passing year fits this branch + semester in this session, and who already has a class.
router.get('/wizard-students', wrap(async (req, res) => {
  const session = clean(req.query.session);
  const { branch, sem, passingYear } = await sessionFacts(session, Number(req.query.branchId), req.query.semester);
  const students = await dbAll(
    `SELECT s.id, s.name, s.roll_number,
            (SELECT b2.abbr || '-' || c2.semester || c2.section FROM students_mapping sm2
               JOIN classes c2 ON c2.id = sm2.class_id JOIN branches b2 ON b2.id = c2.branch_id
              WHERE sm2.student_id = s.id AND c2.academic_session = ? LIMIT 1) AS assignedTo
     FROM students s WHERE s.active = 1 AND s.year_of_passing = ?
     ORDER BY s.roll_number, s.name`, [session, passingYear]);
  res.json({ ok: true, branch: branch.abbr, semester: sem, passingYear, durationYears: branch.duration_years, students });
}));

// Creates the classes (branch + semester + section + home room) and puts the chosen students in them.
router.post('/wizard-apply', wrap(async (req, res) => {
  const session = clean(req.body?.session);
  const cohorts = Array.isArray(req.body?.cohorts) ? req.body.cohorts : [];
  if (!cohorts.length) throw new HttpError(400, 'nothing_to_create', 'Add at least one branch and semester.');
  let created = 0, existing = 0, assigned = 0, skipped = 0;
  const roomSection = new Map(); // a home room can hold one section only (DS 5D and AIML 5D share it, 5D)
  await withTransaction(async () => {
    for (const cohort of cohorts) {
      const { sem } = await sessionFacts(session, Number(cohort.branchId), cohort.semester);
      if (!Array.isArray(cohort.sections) || !cohort.sections.length) throw new HttpError(400, 'invalid_value', 'Give every branch and semester at least one section.');
      for (const sec of cohort.sections) {
        const section = checkSection(sec.section);
        const roomId = Number(sec.roomId) || null;
        if (roomId) {
          const room = await dbGet(`SELECT block || '-' || number AS label FROM rooms WHERE id = ?`, [roomId]);
          if (!room) throw new HttpError(400, 'invalid_reference', 'That home room no longer exists.');
          const taken = roomSection.get(roomId)
            ?? (await dbGet(`SELECT section FROM classes WHERE room_id = ? AND academic_session = ? AND section != ? LIMIT 1`, [roomId, session, section]))?.section;
          if (taken && taken !== section) throw new HttpError(400, 'room_taken', `${room.label} is already the home room of section ${taken}. Pick another room, or use the same section.`);
          roomSection.set(roomId, section);
        }
        const made = await dbRun(
          `INSERT OR IGNORE INTO classes (branch_id, semester, room_id, section, academic_session) VALUES (?, ?, ?, ?, ?)`,
          [Number(cohort.branchId), sem, roomId, section, session]);
        const row = await dbGet(`SELECT id FROM classes WHERE branch_id = ? AND semester = ? AND section = ? AND academic_session = ?`,
          [Number(cohort.branchId), sem, section, session]);
        if (made.changes) created++; else existing++;
        if (roomId) await dbRun(`UPDATE classes SET room_id = ? WHERE id = ?`, [roomId, row.id]);
        for (const id of [...new Set((sec.studentIds || []).map(Number))].filter(Boolean)) {
          const student = await dbGet(`SELECT id FROM students WHERE id = ? AND active = 1`, [id]);
          const already = await dbGet(
            `SELECT 1 AS x FROM students_mapping sm JOIN classes c ON c.id = sm.class_id WHERE sm.student_id = ? AND c.academic_session = ?`, [id, session]);
          if (!student || already) { skipped++; continue; }
          await dbRun(`INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, NULL)`, [id, row.id]);
          assigned++;
        }
      }
    }
  });
  res.json({ ok: true, created, existing, assigned, skipped });
}));

export default router;
