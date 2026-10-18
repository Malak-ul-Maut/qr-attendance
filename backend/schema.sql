-- =====================================================================
-- Smart attendance schema (SQLite)
-- NOTE: foreign keys are OFF by default in SQLite and the setting is per
-- connection. Run `PRAGMA foreign_keys = ON;` every time your app opens the DB
-- (better-sqlite3 already does this; the plain `sqlite3` package does not).
-- =====================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL UNIQUE,
  duration_years INTEGER NOT NULL DEFAULT 4 CHECK (duration_years BETWEEN 1 AND 6)   -- B.Tech = 4
);

CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  UNIQUE (course_id, abbr)
);

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block TEXT NOT NULL,
  number TEXT NOT NULL,
  type TEXT CHECK(type IN ('classroom','seminar_hall','lab')) NOT NULL,
  camera_url TEXT,
  UNIQUE (block, number)
);

-- Slot times are 24-hour, zero-padded 'HH:MM' text ('09:30', '13:30').
-- In that format plain text sorting equals time sorting. The CHECKs reject
-- '9:30', '25:00' and end times that are not after the start time.
CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  start_time TEXT NOT NULL UNIQUE,
  end_time TEXT NOT NULL,
  CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND time(start_time) IS NOT NULL),
  CHECK (end_time   GLOB '[0-2][0-9]:[0-5][0-9]' AND time(end_time)   IS NOT NULL),
  CHECK (start_time < end_time)
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL CHECK (length(abbr) > 0),
  -- 0 for TRAINING, PROJECT, PLACEMENT PREPARATION etc. A session cannot be started for them.
  takes_attendance INTEGER NOT NULL DEFAULT 1 CHECK (takes_attendance IN (0,1))
);

CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT 'password'
);

-- No face data here: a student can exist (e.g. CSV import) before any photo does.
-- Face data lives in the face_embedding column below.
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  roll_number TEXT UNIQUE,
  college_email VARCHAR(255) UNIQUE,
  phone_number VARCHAR(20) UNIQUE,
  year_of_passing INTEGER NOT NULL,
  face_embedding BLOB,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL DEFAULT 'password',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))   -- 1 = active, 0 = inactive
);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  semester INTEGER NOT NULL,
  room_id INTEGER REFERENCES rooms(id),          -- the class's home room (e.g. F-307)
  section TEXT NOT NULL,                         -- any short label: A, B, 3 ...
  academic_session TEXT NOT NULL,                -- e.g. '2026-2027 ODD'
  counsellor TEXT,                               -- class counsellor, printed on the timetable sheet
  UNIQUE (branch_id, semester, section, academic_session)
);

CREATE TABLE students_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  batch TEXT,                                    -- 'G1', 'G2', ... NULL = no batch
  UNIQUE (student_id, class_id)
);
CREATE INDEX idx_students_mapping_class ON students_mapping(class_id);

CREATE TABLE faculties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT 'password',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))   -- 1 = active, 0 = left the institute
);

-- =====================================================================
-- TIMETABLE
-- One row = one subject, taught by one faculty, in one room, in one period.
-- Which class(es)/batch it is for is stored in timetable_classes.
--
-- History: valid_from / valid_to are dates (YYYY-MM-DD), both inclusive.
--   valid_to IS NULL means "still in force".
--   To EDIT a cell: set valid_to = (change date - 1 day) on the old row,
--   then insert a new row with valid_from = change date. Never overwrite the old row
--   once sessions exist (a trigger blocks it).
--   To DELETE a cell: just set valid_to. Old sessions keep pointing at the old row.
--   An extra (arranged) class needs no timetable row: its session has timetable_id NULL (see sessions).
-- =====================================================================
CREATE TABLE timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER REFERENCES rooms(id),
  day TEXT CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')) NOT NULL,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  faculty_id INTEGER REFERENCES faculties(id),
  valid_from DATE NOT NULL,
  valid_to DATE,
  CHECK (date(valid_from) = valid_from),
  CHECK (valid_to IS NULL OR (date(valid_to) = valid_to AND valid_to >= valid_from))
);
CREATE INDEX idx_timetable_day_slot ON timetable(day, slot_id);

-- A teacher / a room can have only one CURRENT row per day+period.
CREATE UNIQUE INDEX uq_timetable_faculty_open ON timetable(faculty_id, day, slot_id)
  WHERE valid_to IS NULL AND faculty_id IS NOT NULL;
CREATE UNIQUE INDEX uq_timetable_room_open ON timetable(room_id, day, slot_id)
  WHERE valid_to IS NULL AND room_id IS NOT NULL;

-- Link table: which class (and which batch) a timetable row is for.
--   batch NULL = whole class, 'G1' = that group only.
--   A combined lecture = one timetable row with several links.
CREATE TABLE timetable_classes (
  timetable_id INTEGER NOT NULL REFERENCES timetable(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  batch TEXT
);
-- Not a PRIMARY KEY on purpose: SQLite lets NULLs repeat inside a primary key,
-- so (1, 5, NULL) could be inserted twice. This index treats NULL as ''.
CREATE UNIQUE INDEX uq_timetable_classes ON timetable_classes(timetable_id, class_id, COALESCE(batch, ''));
CREATE INDEX idx_timetable_classes_class ON timetable_classes(class_id);

-- One-day rows are closed (valid_to is set), so the partial indexes above skip them.
-- This trigger checks date overlaps instead, covering arranged classes too.
CREATE TRIGGER trg_timetable_no_overlap
BEFORE INSERT ON timetable
BEGIN
  SELECT RAISE(ABORT, 'Faculty already has a class in this period')
  WHERE NEW.faculty_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM timetable t
    WHERE t.faculty_id = NEW.faculty_id AND t.day = NEW.day AND t.slot_id = NEW.slot_id
      AND t.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      AND NEW.valid_from <= COALESCE(t.valid_to, '9999-12-31'));
  SELECT RAISE(ABORT, 'Room is already booked in this period')
  WHERE NEW.room_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM timetable t
    WHERE t.room_id = NEW.room_id AND t.day = NEW.day AND t.slot_id = NEW.slot_id
      AND t.valid_from <= COALESCE(NEW.valid_to, '9999-12-31')
      AND NEW.valid_from <= COALESCE(t.valid_to, '9999-12-31'));
END;

-- A class (or the same batch / the whole class vs a batch) cannot be in two places at once.
CREATE TRIGGER trg_timetable_classes_no_clash
BEFORE INSERT ON timetable_classes
BEGIN
  SELECT RAISE(ABORT, 'This class/batch already has another class in this period')
  WHERE EXISTS (
    SELECT 1
    FROM timetable_classes tc
    JOIN timetable other ON other.id = tc.timetable_id
    JOIN timetable mine  ON mine.id  = NEW.timetable_id
    WHERE tc.class_id = NEW.class_id
      AND tc.timetable_id <> NEW.timetable_id
      AND other.day = mine.day AND other.slot_id = mine.slot_id
      AND other.valid_from <= COALESCE(mine.valid_to, '9999-12-31')
      AND mine.valid_from <= COALESCE(other.valid_to, '9999-12-31')
      AND (tc.batch IS NULL OR NEW.batch IS NULL OR tc.batch = NEW.batch));
END;

-- Once a row has sessions, its day / slot / subject / faculty / room are frozen,
-- otherwise past sessions would silently change their subject. Close it and add a new row.
CREATE TRIGGER trg_timetable_freeze_history
BEFORE UPDATE OF room_id, day, slot_id, subject_id, faculty_id, valid_from ON timetable
WHEN EXISTS (SELECT 1 FROM sessions WHERE timetable_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Timetable row already has sessions: set valid_to and insert a new row instead');
END;

-- =====================================================================
-- SESSIONS & ATTENDANCE
-- =====================================================================
-- A session = one period of one class actually taken. It stores what REALLY happened (faculty, subject,
-- room, period), which can differ from the timetable row it came from:
--   regular  = the faculty's own planned period
--   borrowed = the faculty took a period planned for another faculty (timetable_id = that row)
--   arranged = an extra class with no timetable row (any Monday-Saturday)
-- Which classes it covered is in session_classes (a faculty can merge classes into one session).
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timetable_id INTEGER REFERENCES timetable(id),          -- the planned row this session fulfils; NULL for an arranged class
  date DATE NOT NULL CHECK (date(date) = date),
  session_code TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('qr','cctv')),
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_time DATETIME,
  slot_id INTEGER NOT NULL REFERENCES slots(id),          -- the period it was really held in
  subject_id INTEGER NOT NULL REFERENCES subjects(id),    -- what was really taught
  faculty_id INTEGER REFERENCES faculties(id),            -- who really took it
  room_id INTEGER REFERENCES rooms(id),                   -- where it was really held (the camera used for CCTV)
  kind TEXT NOT NULL DEFAULT 'regular' CHECK(kind IN ('regular','borrowed','arranged')),
  UNIQUE (timetable_id, date),
  CHECK (kind = 'arranged' OR timetable_id IS NOT NULL)
);

CREATE INDEX idx_sessions_date ON sessions(date);
CREATE INDEX idx_sessions_code ON sessions(session_code);
CREATE INDEX idx_sessions_slot ON sessions(date, slot_id);

-- Which class (and batch) a session covers. One row per class; merged = 1 when the faculty added it.
CREATE TABLE session_classes (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  batch TEXT,
  merged INTEGER NOT NULL DEFAULT 0 CHECK (merged IN (0,1))   -- 1 = added by the faculty (a merged class)
);
CREATE UNIQUE INDEX uq_session_classes ON session_classes(session_id, class_id, COALESCE(batch, ''));
CREATE INDEX idx_session_classes_class ON session_classes(class_id);

-- Validate a new session. The subject must take attendance; a session tied to a timetable row must be
-- in that row's period, inside its validity dates and on its weekday; nothing is held on a Sunday.
-- Arranged classes (no timetable row) may be on any Monday-Saturday.
CREATE TRIGGER trg_sessions_validate
BEFORE INSERT ON sessions
BEGIN
  SELECT RAISE(ABORT, 'This subject does not take attendance')
  WHERE EXISTS (SELECT 1 FROM subjects s WHERE s.id = NEW.subject_id AND s.takes_attendance = 0);
  SELECT RAISE(ABORT, 'Sunday has no classes')
  WHERE strftime('%w', NEW.date) = '0';
  SELECT RAISE(ABORT, 'Date is outside the timetable row validity or on the wrong weekday')
  WHERE NEW.timetable_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM timetable t
    WHERE t.id = NEW.timetable_id
      AND t.slot_id = NEW.slot_id
      AND NEW.date >= t.valid_from
      AND NEW.date <= COALESCE(t.valid_to, '9999-12-31')
      AND t.day = CASE strftime('%w', NEW.date)
                    WHEN '1' THEN 'Monday'   WHEN '2' THEN 'Tuesday'
                    WHEN '3' THEN 'Wednesday' WHEN '4' THEN 'Thursday'
                    WHEN '5' THEN 'Friday' END);
END;

-- THE COORDINATION RULE: a class (or batch) can be in only one session per date and period, whoever
-- takes it. A borrowed period, a merged class and a faculty's own slot all go through this one check,
-- so the lender cannot start a period that was borrowed, and two faculty cannot both mark one class.
CREATE TRIGGER trg_session_classes_no_clash
BEFORE INSERT ON session_classes
BEGIN
  SELECT RAISE(ABORT, 'This class/batch already has a session in this period')
  WHERE EXISTS (
    SELECT 1
    FROM session_classes sc
    JOIN sessions other ON other.id = sc.session_id
    JOIN sessions mine  ON mine.id  = NEW.session_id
    WHERE sc.class_id = NEW.class_id
      AND sc.session_id <> NEW.session_id
      AND other.date = mine.date AND other.slot_id = mine.slot_id
      AND (sc.batch IS NULL OR NEW.batch IS NULL OR sc.batch = NEW.batch));
END;


-- MEANING OF A ROW: when a session starts, create one attendance row for every student
-- of the linked class(es)/batch.
--   marked_at IS NULL     -> ABSENT (not marked yet)
--   marked_at IS NOT NULL -> PRESENT, and `method` says how ('qr','cctv','manual')
-- Attendance % = rows with marked_at NOT NULL / all rows, per student.
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  marked_at DATETIME,
  method TEXT CHECK(method IN ('qr','cctv','manual')),
  camera_fingerprint TEXT,
  UNIQUE (session_id, student_id)
);
CREATE INDEX idx_attendance_student ON attendance(student_id);

-- Timetable drafting: one shared working copy (with undo / redo history) that is published as a new version.
CREATE TABLE IF NOT EXISTS timetable_draft (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_date TEXT NOT NULL,
  base_json TEXT NOT NULL,
  history_json TEXT NOT NULL,
  pos INTEGER NOT NULL,
  next_n INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
