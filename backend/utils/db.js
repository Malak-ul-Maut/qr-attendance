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
