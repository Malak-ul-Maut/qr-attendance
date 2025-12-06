const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'attendance.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
    if (err) console.error('Database connection failed:', err);
    else console.log('Connected to SQLite database');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            username TEXT UNIQUE,
            password TEXT
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS faculty (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            studentId TEXT NOT NULL,
            courseId TEXT NOT NULL,
            sessionId TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified INTEGER DEFAULT 1,
            finalised INTEGER DEFAULT 0,
            removed INTEGER DEFAULT 0
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            sessionId TEXT PRIMARY KEY,
            courseId TEXT,
            teacherId TEXT,
            startTime DATETIME DEFAULT CURRENT_TIMESTAMP,
            endTime DATETIME,
            status TEXT DEFAULT 'active'
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            name TEXT,
            username TEXT PRIMARY,
            password TEXT,
            subjectName TEXT DEFAULT NULL
        );
    `);

});

module.exports = db;
