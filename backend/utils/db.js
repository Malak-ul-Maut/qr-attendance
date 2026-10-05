import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../attendance.db');
const db = new sqlite3.Database(
  dbPath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  err => {
    if (err) console.error('Database connection failed:', err);
    else console.log('Connected to SQLite database');
  },
);

db.serialize(() => {
  // WAL mode: readers and writers no longer block each other.
  // This setting is saved in the database file, so it sticks after the first run.
  db.run('PRAGMA journal_mode = WAL');

  // Lets SQLite wait for a lock instead of failing right away.
  // This one resets on every new connection, so it must run every time.
  db.configure('busyTimeout', 5000); // milliseconds

  // Optional: enforce foreign keys (off by default in SQLite).
  // Useful with your timetable/classes/rooms relationships.
  db.run('PRAGMA foreign_keys = ON');
});

export default db;
