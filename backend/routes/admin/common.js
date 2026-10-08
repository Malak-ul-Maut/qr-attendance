import { dbAll } from '../../utils/db.js';
import { randomInt } from 'crypto';
import { dbGet } from '../../utils/db.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const clean = value => {
  const text = String(value ?? '').trim();
  return text || null;
};

// Turns any thrown error into { status, error, message } for the client.
export function describeError(err) {
  if (err instanceof HttpError)
    return { status: err.status, error: err.code, message: err.message, ...err.extra };
  if (err?.code === 'SQLITE_CONSTRAINT') {
    const text = String(err.message).replace(/^SQLITE_CONSTRAINT:\s*/, '');
    if (/UNIQUE constraint failed/.test(text)) {
      const column = text.split('failed: ')[1]?.split(',')[0]?.split('.').pop() || 'value';
      return { status: 409, error: 'duplicate', message: `That ${column.replaceAll('_', ' ')} is already in use.` };
    }
    if (/FOREIGN KEY/.test(text))
      return { status: 409, error: 'in_use', message: 'Other records still use this item, or a linked item does not exist.' };
    if (/NOT NULL/.test(text))
      return { status: 400, error: 'required_value_missing', message: 'A required value is missing.' };
    if (/CHECK constraint/.test(text))
      return { status: 400, error: 'invalid_value', message: 'A value is not allowed (check the format).' };
    return { status: 409, error: 'conflict', message: text };
  }
  console.error(err);
  return { status: 500, error: 'database_error', message: 'Database error.' };
}

export function sendError(res, err) {
  const { status, ...body } = describeError(err);
  return res.status(status).json({ ok: false, ...body });
}

export const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

// "Mr. Rajat Kumar" -> RK, then RK2, RK3 ... until unused.
export async function makeUniqueAbbr(name) {
  const letters = name
    .replace(/\b(mr|mrs|ms|miss|dr|prof)\b\.?/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 3);
  const base = letters || 'FAC';
  let candidate = base;
  for (let n = 2; await dbGet(`SELECT 1 FROM faculties WHERE abbr = ?`, [candidate]); n++)
    candidate = `${base}${n}`;
  return candidate;
}

export const classLabelSql = (c = 'c', b = 'b') =>
  `${b}.abbr || ' ' || ${c}.semester || ${c}.section`;

// ---------------- Accounts: passwords and format checks (shared by the form and CSV import) ----------------
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O or 1/l/I look-alikes
export const generatePassword = (length = 10) =>
  Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');

// New accounts no longer start with the guessable password "password"
export function checkPassword(value) {
  if (value.length < 6) throw new HttpError(400, 'invalid_value', 'Password must be at least 6 characters.');
  if (value.toLowerCase() === 'password') throw new HttpError(400, 'invalid_value', 'Choose a password other than "password".');
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function checkEmail(value) {
  if (!EMAIL.test(value)) throw new HttpError(400, 'invalid_value', 'College email must look like name@college.edu.');
  return value;
}
export function checkPhone(value) {
  if (!/^\+?\d{10,13}$/.test(value.replace(/[\s()-]/g, '')))
    throw new HttpError(400, 'invalid_value', 'Phone must be 10 digits, optionally starting with +91.');
  return value;
}
export function checkUsername(value) {
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(value))
    throw new HttpError(400, 'invalid_value', 'Username must be 3 to 30 letters, numbers, dots, dashes or underscores, with no spaces.');
  return value;
}
export const YEAR_MIN = 2000;
export const yearMax = () => new Date().getFullYear() + 10;
export function checkYear(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < YEAR_MIN || n > yearMax())
    throw new HttpError(400, 'invalid_value', `Year of passing must be between ${YEAR_MIN} and ${yearMax()}.`);
  return n;
}

// ---------------- Classrooms and cohorts ----------------
// A classroom = one home room + the class(es) in it (CSE-5A, DS/AIML-5D ...). Classes that share a home
// room in the same session are one classroom; a class with no home room is a classroom of its own.
export async function classroomMap() {
  const rows = await dbAll(
    `SELECT c.id, c.room_id, c.semester, c.section, c.academic_session, b.abbr AS branch
     FROM classes c JOIN branches b ON b.id = c.branch_id ORDER BY b.abbr, c.semester, c.section`);
  const groups = new Map();
  for (const r of rows) {
    const key = r.room_id ? `${r.academic_session}|room${r.room_id}` : `class${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const byClass = new Map();
  for (const [key, list] of groups) {
    const names = new Set(list.map(r => `${r.semester}${r.section}`));
    const label = names.size === 1
      ? `${[...new Set(list.map(r => r.branch))].join('/')}-${[...names][0]}`
      : list.map(r => `${r.branch}-${r.semester}${r.section}`).join(' + ');
    for (const r of list) byClass.set(r.id, { key, label });
  }
  return byClass;
}

// Year a student of this semester finishes: 2026-27 ODD, semester 5 (year 3 of 4) -> 2026 + 4 - 3 + 1 = 2028.
export function passingYearFor(session, durationYears, semester) {
  const start = Number(/^(\d{4})-/.exec(session || '')?.[1]);
  if (!start) return null;
  return start + Number(durationYears) - Math.ceil(Number(semester) / 2) + 1;
}
