import express from 'express';
import { dbAll, dbGet, dbRun, withTransaction } from '../../utils/db.js';
import { todayLocal, isValidDate } from '../../utils/dates.js';
import { HttpError, clean, describeError, makeUniqueAbbr, generatePassword, checkPassword, checkEmail, checkPhone, checkUsername, checkYear } from './common.js';
import { working, mutateNow, lookups, conflictsFor, conflictError } from '../../utils/timetable-draft.js';

const router = express.Router();
const MAX_ROWS = 5000;
const ALIASES = {
  roll: 'rollnumber', rollno: 'rollnumber', rollnum: 'rollnumber',
  email: 'collegeemail', mail: 'collegeemail', phone: 'phonenumber', mobile: 'phonenumber',
  year: 'yearofpassing', passingyear: 'yearofpassing', yop: 'yearofpassing',
  sem: 'semester', group: 'batch', fullname: 'name', facultyname: 'name',
  periodname: 'period', slot: 'period', teacher: 'faculty', subjectcode: 'subject',
  starts: 'validfrom', from: 'validfrom', effectivefrom: 'validfrom', academicsession: 'session',
};

function normalise(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    out[ALIASES[k] || k] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}
const need = (value, label) => {
  if (!clean(value)) throw new HttpError(400, 'required_value_missing', `${label} is required.`);
  return String(value).trim();
};

async function resolveClass(r) {
  const branch = need(r.branch, 'branch');
  const semester = Number(need(r.semester, 'semester'));
  const section = need(r.section, 'section').toUpperCase();
  const where = [`LOWER(b.abbr) = LOWER(?)`, `c.semester = ?`, `c.section = ?`];
  const params = [branch, semester, section];
  if (clean(r.course)) { where.push(`LOWER(co.abbr) = LOWER(?)`); params.push(r.course); }
  if (clean(r.session)) { where.push(`c.academic_session = ?`); params.push(r.session); }
  const found = await dbGet(
    `SELECT c.id, c.academic_session AS session FROM classes c
     JOIN branches b ON b.id = c.branch_id JOIN courses co ON co.id = b.course_id
     WHERE ${where.join(' AND ')} ORDER BY c.academic_session DESC LIMIT 1`,
    params,
  );
  if (!found)
    throw new HttpError(400, 'class_not_found', `No class "${branch} sem ${semester} ${section}${r.session ? ' ' + r.session : ''}". Create it first (Setup → Classes or the term wizard).`);
  return { ...found, semester };
}

// Same rule the old student form used: 8 semesters, ODD sessions start the year given.
function guessYearOfPassing(session, semester) {
  const start = Number(String(session).slice(0, 4));
  if (!start) return new Date().getFullYear() + 2;
  return start + Math.ceil((9 - semester) / 2);
}

async function importStudent(r) {
  const name = need(r.name, 'name');
  const roll = need(r.rollnumber, 'roll number');
  const username = checkUsername(clean(r.username) || roll.toLowerCase());
  const cls = await resolveClass(r);
  const year = clean(r.yearofpassing) ? checkYear(r.yearofpassing) : guessYearOfPassing(cls.session, cls.semester);
  const email = clean(r.collegeemail) && checkEmail(clean(r.collegeemail));
  const phone = clean(r.phonenumber) && checkPhone(clean(r.phonenumber));
  const given = clean(r.password) && checkPassword(clean(r.password));
  const batch = clean(r.batch);
  const existing = await dbGet(`SELECT id FROM students WHERE username = ? OR roll_number = ? ORDER BY username = ? DESC`, [username, roll, username]);
  let id;
  let status;
  let generated = null;
  if (existing) {
    id = existing.id;
    status = 'update';
    await dbRun(
      `UPDATE students SET name = ?, roll_number = ?, college_email = COALESCE(?, college_email),
         phone_number = COALESCE(?, phone_number), year_of_passing = ?, active = 1,
         password_hash = COALESCE(?, password_hash) WHERE id = ?`,
      [name, roll, email || null, phone || null, year, given, id],
    );
  } else {
    status = 'create';
    generated = given ? null : generatePassword();
    id = (await dbRun(
      `INSERT INTO students (name, roll_number, college_email, phone_number, year_of_passing, username, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, roll, email || null, phone || null, year, username, given || generated],
    )).lastID;
  }
  const mapped = await dbGet(`SELECT id FROM students_mapping WHERE student_id = ? AND class_id = ?`, [id, cls.id]);
  if (mapped) await dbRun(`UPDATE students_mapping SET batch = ? WHERE id = ?`, [batch, mapped.id]);
  else await dbRun(`INSERT INTO students_mapping (student_id, class_id, batch) VALUES (?, ?, ?)`, [id, cls.id, batch]);
  return { status, message: `${name} → ${r.branch} sem ${cls.semester} ${String(r.section).toUpperCase()}`, ...(generated ? { credential: { name, username, password: generated } } : {}) };
}

async function importFaculty(r) {
  const name = need(r.name, 'name');
  const abbr = clean(r.abbr) || clean(r.abbreviation);
  const username = clean(r.username) || (abbr ? abbr.toLowerCase() : null);
  if (!username) throw new HttpError(400, 'required_value_missing', 'username (or abbr) is required.');
  checkUsername(username);
  const given = clean(r.password) && checkPassword(clean(r.password));
  const existing = await dbGet(`SELECT id FROM faculties WHERE username = ? OR (? IS NOT NULL AND abbr = ?)`, [username, abbr, abbr]);
  if (existing) {
    await dbRun(
      `UPDATE faculties SET name = ?, abbr = COALESCE(?, abbr), password_hash = COALESCE(?, password_hash) WHERE id = ?`,
      [name, abbr, given, existing.id],
    );
    return { status: 'update', message: name };
  }
  const generated = given ? null : generatePassword();
  await dbRun(`INSERT INTO faculties (name, abbr, username, password_hash) VALUES (?, ?, ?, ?)`, [
    name, abbr || (await makeUniqueAbbr(name)), username, given || generated,
  ]);
  return { status: 'create', message: name, ...(generated ? { credential: { name, username, password: generated } } : {}) };
}

const DAY_MAP = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

async function importTimetableFactory() {
  const slots = await dbAll(`SELECT id, label, start_time FROM slots`);
  const subjects = await dbAll(`SELECT id, code, abbr FROM subjects`);
  const faculties = await dbAll(`SELECT id, abbr, username, name FROM faculties`);
  const rooms = await dbAll(`SELECT id, block, number FROM rooms`);
  const grouped = new Map(); // same slot/subject/faculty/room in one file = one combined lecture
  const lc = v => String(v).toLowerCase();
  const w = await working();
  const L = await lookups();
  const rows = w.rows.map(r => ({ ...r, links: r.links.map(l => ({ ...l })) }));
  let next = 1_000_000;

  return async r => {
    const cls = await resolveClass(r);
    const day = DAY_MAP[lc(need(r.day, 'day')).slice(0, 3)];
    if (!day) throw new HttpError(400, 'invalid_value', `Unknown day "${r.day}".`);
    const period = need(r.period, 'period');
    const padded = /^\d:\d\d$/.test(period) ? '0' + period : period;
    const slot = slots.find(s => lc(s.label) === lc(period) || lc(s.label) === `period ${lc(period)}` || s.start_time === padded);
    if (!slot) throw new HttpError(400, 'invalid_value', `Unknown period "${period}". Use "Period 1", "1" or a start time like 09:30.`);
    const subjectText = need(r.subject, 'subject');
    const subject = subjects.find(s => lc(s.abbr) === lc(subjectText) || lc(s.code) === lc(subjectText));
    if (!subject) throw new HttpError(400, 'invalid_value', `Unknown subject "${subjectText}" (use the abbreviation or code).`);
    let faculty = null;
    if (clean(r.faculty)) {
      faculty = faculties.find(f => lc(f.abbr) === lc(r.faculty) || lc(f.username) === lc(r.faculty) || lc(f.name) === lc(r.faculty));
      if (!faculty) throw new HttpError(400, 'invalid_value', `Unknown faculty "${r.faculty}".`);
    }
    let room = null;
    if (clean(r.room)) {
      const text = String(r.room).replace(/[\s-]+/g, '').toLowerCase();
      const matches = rooms.filter(x => `${x.block}${x.number}`.toLowerCase() === text || x.number.toLowerCase() === text);
      if (matches.length !== 1) throw new HttpError(400, 'invalid_value', matches.length ? `Room "${r.room}" is ambiguous. Use block-number, e.g. F-307.` : `Unknown room "${r.room}".`);
      room = matches[0];
    }
    const batch = clean(r.batch);
    const link = { classId: cls.id, batch };

    // Imported rows go into the draft (nothing is live until it is published).
    const key = [day, slot.id, subject.id, faculty?.id, room?.id, batch].join('|');
    const sameRow = grouped.get(key);
    if (sameRow) {
      const found = conflictsFor(rows.filter(x => x !== sameRow), L, { day, slotIds: [slot.id], links: [link] });
      if (found.length) throw conflictError(found);
      sameRow.links.push(link);
      return { status: 'create', message: `${day} ${slot.label} ${subject.abbr} (combined with the previous class)` };
    }
    const found = conflictsFor(rows, L, { day, slotIds: [slot.id], facultyId: faculty?.id ?? null, roomId: room?.id ?? null, links: [link] });
    if (found.length) throw conflictError(found);
    const row = { id: `n${next++}`, origin: null, day, slotId: slot.id, subjectId: subject.id, facultyId: faculty?.id ?? null, roomId: room?.id ?? null, links: [link] };
    rows.push(row);
    grouped.set(key, row);
    return { status: 'create', message: `${day} ${slot.label} ${subject.abbr}${batch ? ' ' + batch : ''}` };
  };
  handler.finish = async () => {
    if (!rows.length || rows.length === w.rows.length) return;
    await mutateNow((current, newId) => {
      // re-id the new rows against the stored counter and append them to the draft
      const added = rows.slice(w.rows.length).map(r => ({ ...r, id: newId() }));
      return [...current, ...added];
    });
  };
  return handler;
}

class Rollback extends Error {}

// kind: students | faculty | timetable. commit=false validates everything and rolls back.
router.post('/:kind', async (req, res) => {
  const { kind } = req.params;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!['students', 'faculty', 'timetable'].includes(kind))
    return res.status(404).json({ ok: false, error: 'unknown_import', message: 'Unknown import type.' });
  if (!rows.length || rows.length > MAX_ROWS)
    return res.status(400).json({ ok: false, error: 'invalid_rows', message: `Upload between 1 and ${MAX_ROWS} rows.` });
  const commit = req.body.commit === true;
  const results = [];
  try {
    await withTransaction(async () => {
      const handler = kind === 'students' ? importStudent : kind === 'faculty' ? importFaculty : await importTimetableFactory();
      for (let i = 0; i < rows.length; i++) {
        const row = normalise(rows[i] || {});
        await dbRun('SAVEPOINT imp');
        try {
          results.push({ line: i + 2, ...(await handler(row)) });
          await dbRun('RELEASE imp');
        } catch (err) {
          await dbRun('ROLLBACK TO imp');
          await dbRun('RELEASE imp');
          results.push({ line: i + 2, status: 'error', message: describeError(err).message });
        }
      }
      if (commit && handler.finish) await handler.finish();
      if (!commit) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) {
      const { status, ...body } = describeError(err);
      return res.status(status).json({ ok: false, ...body });
    }
  }
  const count = s => results.filter(r => r.status === s).length;
  // Generated passwords leave the server once, only when the import was really saved
  const credentials = commit ? results.filter(r => r.credential).map(r => r.credential) : [];
  const shown = results.map(({ credential, ...rest }) => rest);
  res.json({ ok: true, committed: commit, created: count('create'), updated: count('update'), errors: count('error'), results: shown, credentials });
});

export default router;
