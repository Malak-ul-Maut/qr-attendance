// Shared demo database for the team, with no real people in it.
//
//   npm run demo-db                      copy backend/db/demo.db to backend/db/database.db (a quick, identical start for everyone)
//   npm run demo-db -- --force           same, replacing an existing database.db
//   npm run demo-db:build                rebuild backend/db/demo.db from your own backend/db/database.db with all personal data removed
//   npm run demo-db:build -- some.db     rebuild it from another database file
//
// What the build step does to the copy (the source file is opened read-only and never changed):
//   students   names, roll numbers, usernames, e-mails, phone numbers -> placeholders; passwords -> 'password'; all face data removed
//   faculty    names, short names, usernames -> placeholders; passwords -> 'password'
//   admin      one account: admin / password
//   rooms      CCTV camera addresses (they contain a login) removed
//   attendance device fingerprints removed
//   logs       names, reasons and the timetable draft removed or replaced
// Timetables, classes, subjects, sessions and attendance marks keep their shape, so the app looks lived-in.
// The result is VACUUMed so deleted values do not linger inside the file.
//
// The demo database is for local development only: every password in it is 'password'.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_DIR = path.join(ROOT, 'backend', 'db');
const DEMO_PATH = path.join(DB_DIR, 'demo.db');
const LIVE_PATH = path.join(DB_DIR, 'database.db');

const open = (file, mode) =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, err => (err ? reject(err) : resolve(db)));
  });
const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, err => (err ? reject(err) : resolve())));
const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const close = db => new Promise((resolve, reject) => db.close(err => (err ? reject(err) : resolve())));

const [command, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
const positional = rest.filter(a => !a.startsWith('--'));

if (command === 'install') install();
else if (command === 'build') await build(positional[0] ? path.resolve(positional[0]) : LIVE_PATH);
else {
  console.error('Usage: node scripts/demo-db.mjs install [--force] | build [source.db]');
  process.exit(1);
}

function install() {
  if (!fs.existsSync(DEMO_PATH)) fail(`${DEMO_PATH} does not exist. Ask a teammate to pull the latest version of the repo.`);
  if (fs.existsSync(LIVE_PATH) && !force)
    fail('backend/db/database.db already exists, so it was left alone.\nRun `npm run demo-db -- --force` to replace it (your current database is lost).');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(LIVE_PATH + suffix, { force: true });
  fs.copyFileSync(DEMO_PATH, LIVE_PATH);
  console.log('Demo database installed at backend/db/database.db');
  console.log('Sign in as admin / password. Students are student numbers (see Setup > Students), faculty are faculty01, faculty02, ...; every password is "password".');
}

async function build(sourcePath) {
  if (!fs.existsSync(sourcePath)) fail(`Source database not found: ${sourcePath}`);
  const tempPath = `${DEMO_PATH}.building`;
  fs.rmSync(tempPath, { force: true });

  // VACUUM INTO writes a clean, self-contained copy (including anything still in the -wal file).
  const source = await open(sourcePath, sqlite3.OPEN_READONLY);
  await run(source, `VACUUM INTO ?`, [tempPath]);
  await close(source);

  const db = await open(tempPath, sqlite3.OPEN_READWRITE);
  try {
    await run(db, 'PRAGMA journal_mode = DELETE'); // a single file, no -wal or -shm next to it
    await run(db, 'BEGIN');

    // Students: numbered placeholders. 13 digits like a real roll number, so the layout looks right.
    const students = await all(db, 'SELECT id FROM students ORDER BY id');
    for (const [index, { id }] of students.entries()) {
      const n = String(index + 1).padStart(3, '0');
      const roll = `2600000000${n}`;
      await run(
        db,
        `UPDATE students SET name = ?, roll_number = ?, username = ?, college_email = ?, phone_number = ?, password_hash = 'password',
           face_embedding = NULL, face_embedding_model = NULL, face_enrolled_at = NULL, face_status = NULL, face_reviewed_at = NULL,
           face_reviewed_by = NULL, face_reject_reason = NULL, face_qa = NULL, face_qa_at = NULL WHERE id = ?`,
        [`Student ${n}`, roll, roll, `student${n}@example.edu`, `90000${String(index + 1).padStart(5, '0')}`, id],
      );
    }

    const faculty = await all(db, 'SELECT id FROM faculties ORDER BY id');
    const facultyName = new Map();
    for (const [index, { id }] of faculty.entries()) {
      const n = String(index + 1).padStart(2, '0');
      facultyName.set(id, `Faculty ${n}`);
      await run(db, `UPDATE faculties SET name = ?, abbr = ?, username = ?, password_hash = 'password' WHERE id = ?`, [
        `Faculty ${n}`, `F${n}`, `faculty${n}`, id,
      ]);
    }

    await run(db, `DELETE FROM admins`);
    await run(db, `INSERT INTO admins (name, username, password_hash) VALUES ('Administrator', 'admin', 'password')`);

    await run(db, `UPDATE rooms SET camera_url = NULL`);
    await run(db, `UPDATE classes SET counsellor = NULL`);
    await run(db, `UPDATE attendance SET camera_fingerprint = NULL`);
    await run(db, `DELETE FROM timetable_draft`);
    await run(db, `UPDATE face_review_log SET admin = 'admin', reason = NULL`);
    await run(db, `UPDATE face_reset_log SET reason = 'demo'`);
    for (const [id, name] of facultyName)
      await run(db, `UPDATE session_discard_log SET faculty_name = ? WHERE faculty_id = ?`, [name, id]);
    await run(db, `UPDATE session_discard_log SET faculty_name = 'Faculty' WHERE faculty_name IS NOT NULL AND faculty_name NOT LIKE 'Faculty %'`);

    await run(db, 'COMMIT');
    await run(db, 'VACUUM'); // drop the old values from free pages
    await close(db);
  } catch (err) {
    await close(db).catch(() => {});
    fs.rmSync(tempPath, { force: true });
    fail(`Could not build the demo database: ${err.message}`);
  }

  fs.renameSync(tempPath, DEMO_PATH);
  console.log(`Wrote ${path.relative(ROOT, DEMO_PATH)} (${Math.round(fs.statSync(DEMO_PATH).size / 1024)} KB) from ${path.relative(ROOT, sourcePath) || sourcePath}.`);
  console.log('Open it once and look around before you commit it. It is meant to hold no real names, numbers or logins.');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
