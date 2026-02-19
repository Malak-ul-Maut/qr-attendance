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
  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            name TEXT,
            username TEXT UNIQUE PRIMARY KEY,
            password TEXT DEFAULT password,
            role TEXT NOT NULL,
            section TEXT DEFAULT NULL,
            subjectName TEXT DEFAULT NULL
        );
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            studentId TEXT NOT NULL,
            courseId TEXT NOT NULL,
            sessionId TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            removed INTEGER DEFAULT 0
        );
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            sessionId TEXT PRIMARY KEY,
            section TEXT,
            courseId TEXT,
            teacherId TEXT,
            startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
            endTime DATETIME,
            status TEXT DEFAULT 'active'
  );`);
});

export default db;
