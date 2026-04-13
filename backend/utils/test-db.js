import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../test-attendance.db');
const db = new sqlite3.Database(
  dbPath,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  err => {
    if (err) console.error('Database connection failed:', err);
    else console.log('Connected to SQLite database');
  },
);

db.serialize(() => {
  // USERS (single auth table for all roles)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL DEFAULT 'password',
      role TEXT CHECK(role IN ('student','faculty','admin')) NOT NULL
    );
  `);

  // ACADEMIC STRUCTURE

  db.run(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      abbr TEXT NOT NULL UNIQUE           
    ); 
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      name TEXT NOT NULL,
      abbr TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      label TEXT
    );
  `);

  // A "class" is a unique group: course + branch + semester + section
  db.run(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      semester INTEGER,
      section_id INTEGER NOT NULL REFERENCES sections(id),
      UNIQUE (course_id, branch_id, semester, section_id)
    );
  `);

  // CURRICULUM & SUBJECTS

  // Defines which subjects exist for a given course/branch/semester combination
  db.run(`
    CREATE TABLE IF NOT EXISTS curriculum (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      branch_id INTEGER NOT NULL REFERENCES branches(id),
      semester INTEGER,
      UNIQUE (course_id, branch_id, semester)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      abbr TEXT,
      curriculum_id INTEGER NOT NULL REFERENCES curriculum(id)
    );
  `);

  // FACULTY
  db.run(`
    CREATE TABLE IF NOT EXISTS faculty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      name TEXT NOT NULL
    );
  `);

  // A teacher can teach multiple subjects; a subject can be taught by multiple teachers
  db.run(`
    CREATE TABLE IF NOT EXISTS faculty_subjects (
      faculty_id INTEGER NOT NULL REFERENCES faculty(id),
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      PRIMARY KEY (faculty_id, subject_id)
    );
  `);

  //STUDENTS
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      roll_number TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      face_descriptor TEXT
    );
  `);

  // SLOTS (period timings)
  db.run(`
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
  `);

  // TIMETABLE: maps a recurring weekly slot to a teacher, subject, and class
  db.run(`
    CREATE TABLE IF NOT EXISTS timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')) NOT NULL,
      slot_id INTEGER NOT NULL REFERENCES slots(id),
      teacher_id INTEGER NOT NULL REFERENCES faculty(id),
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      UNIQUE (day, slot_id, class_id) 
    );
  `);

  // SESSIONS: An actual instance of a timetable entry on a specific date
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timetable_id INTEGER NOT NULL REFERENCES timetable(id),
      date DATE NOT NULL,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      UNIQUE (timetable_id, date)
    );
  `);

  // ATTENDANCE
  db.run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      status TEXT CHECK(status IN ('present','absent')) DEFAULT 'present',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (session_id, student_id)
    );
  `);
});

export default db;
