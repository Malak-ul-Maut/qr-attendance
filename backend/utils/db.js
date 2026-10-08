import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../database.db');

// OPEN_CREATE is left out on purpose: if database.db is missing, fail loudly instead of
// silently creating an empty database with no tables.
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, err => {
  if (err) console.error('Database connection failed:', err);
  else console.log('Connected to SQLite database');
});

db.serialize(() => {
  // WAL mode: readers and writers no longer block each other.
  // This setting is saved in the database file, so it sticks after the first run.
  db.run('PRAGMA journal_mode = WAL');

  // Lets SQLite wait for a lock instead of failing right away.
  // This one resets on every new connection, so it must run every time.
  db.configure('busyTimeout', 5000); // milliseconds

  // Added after the first release: the class counsellor printed on timetable sheets.
  // Safe to run every time - SQLite refuses a second ADD COLUMN and we ignore that one error.
  db.run('ALTER TABLE classes ADD COLUMN counsellor TEXT', err => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Could not add classes.counsellor:', err);
  });

  // Stage 5: a course has a length in years (B.Tech = 4); the term wizard uses it to find each semester's passing year.
  db.run('ALTER TABLE courses ADD COLUMN duration_years INTEGER NOT NULL DEFAULT 4', err => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Could not add courses.duration_years:', err);
  });
  // Stage 5: faculty can leave the institute, so they get an active flag like students.
  db.run('ALTER TABLE faculties ADD COLUMN active INTEGER NOT NULL DEFAULT 1', err => {
    if (err && !/duplicate column/i.test(err.message)) console.error('Could not add faculties.active:', err);
  });

  // Stage 4: sections are free text now (any value). Older databases carry a CHECK that only
  // allows A-E, and SQLite cannot drop a CHECK in place, so the table is rebuilt once.
  db.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classes'`, (err, row) => {
    if (err || !row || !/CHECK\s*\(\s*section\s+IN/i.test(row.sql)) return;
    db.serialize(() => {
      db.run('PRAGMA foreign_keys = OFF');
      db.run('PRAGMA legacy_alter_table = ON');
      db.run('BEGIN');
      db.run(`CREATE TABLE classes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        semester INTEGER NOT NULL,
        room_id INTEGER REFERENCES rooms(id),
        section TEXT NOT NULL,
        academic_session TEXT NOT NULL,
        counsellor TEXT,
        UNIQUE (branch_id, semester, section, academic_session))`);
      db.run(`INSERT INTO classes_new (id, branch_id, semester, room_id, section, academic_session, counsellor)
              SELECT id, branch_id, semester, room_id, section, academic_session, counsellor FROM classes`);
      db.run('DROP TABLE classes');
      db.run('ALTER TABLE classes_new RENAME TO classes');
      db.run('COMMIT', e => {
        if (e) { console.error('Could not free up classes.section:', e); db.run('ROLLBACK'); }
        else console.log('classes.section is now free text');
      });
      db.run('PRAGMA legacy_alter_table = OFF');
      db.run('PRAGMA foreign_keys = ON');
    });
  });

  // Enforce foreign keys (off by default in SQLite, and per connection).
  db.run('PRAGMA foreign_keys = ON');
});

// ---------------------------------------------------------------------------
// Promise helpers, shared by every route file
// ---------------------------------------------------------------------------
export function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

export function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

export function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// Runs fn inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK if fn throws).
// There is one shared connection, so two transactions must never overlap:
// they are queued and run one after the other.
let transactionQueue = Promise.resolve();
export function withTransaction(fn) {
  const run = transactionQueue.then(async () => {
    await dbRun('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      await dbRun('COMMIT');
      return result;
    } catch (err) {
      try {
        await dbRun('ROLLBACK');
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
      throw err;
    }
  });
  transactionQueue = run.catch(() => {});
  return run;
}

export default db;
