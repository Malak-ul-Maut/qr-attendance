import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, './database.db');
const schemaPath = path.join(__dirname, './schema.sql');

// ---------------------------------------------------------------------------
// First start: build database.db from schema.sql and add one admin account.
// ---------------------------------------------------------------------------
// This runs only when database.db does not exist. An existing database is never touched.
// The file is built under a temporary name and renamed at the end, so a crash half way
// through cannot leave an empty or half-built database behind for the next start to trust.
if (!fs.existsSync(dbPath)) await createDatabase();

async function createDatabase() {
  const tempPath = `${dbPath}.creating`;
  fs.rmSync(tempPath, { force: true });

  // Login is a plain text comparison for now (see routes/auth.js), so do not seed the well-known
  // default password. Use ADMIN_PASSWORD from .env if set, otherwise make a random one and print it once.
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || randomBytes(9).toString('base64url');

  const seedDb = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(tempPath, err => (err ? reject(err) : resolve(connection)));
  });
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => seedDb.run(sql, params, err => (err ? reject(err) : resolve())));
  const exec = sql =>
    new Promise((resolve, reject) => seedDb.exec(sql, err => (err ? reject(err) : resolve())));
  const close = () => new Promise((resolve, reject) => seedDb.close(err => (err ? reject(err) : resolve())));

  try {
    await exec(fs.readFileSync(schemaPath, 'utf8'));
    await run('INSERT INTO admins (name, username, password_hash) VALUES (?, ?, ?)', [
      'Administrator',
      adminUsername,
      adminPassword,
    ]);
    await close();
  } catch (err) {
    await close().catch(() => {});
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Could not create the database from schema.sql: ${err.message}`);
  }
  fs.renameSync(tempPath, dbPath);

  console.log('\nNo database found, so a new one was created from backend/db/schema.sql.');
  console.log(`First admin account:  username: ${adminUsername}`);
  console.log(
    process.env.ADMIN_PASSWORD
      ? '                      password: the ADMIN_PASSWORD value from .env'
      : `                      password: ${adminPassword}   (shown once; write it down)`,
  );
  console.log('Next: sign in as admin and use Setup > Term setup wizard to add your term, rooms and people.\n');
}

// An existing database.db is opened read/write. It is only ever created by createDatabase() above.
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, err => {
  if (err) console.error('Database connection failed:', err);
});

db.serialize(() => {
  // WAL mode: readers and writers no longer block each other.
  // This setting is saved in the database file, so it sticks after the first run.
  db.run('PRAGMA journal_mode = WAL');

  // Lets SQLite wait for a lock instead of failing right away.
  // This one resets on every new connection, so it must run every time.
  db.configure('busyTimeout', 5000); // milliseconds

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
