import express from 'express';
import db, { dbAll, dbGet, dbRun } from '../utils/db.js';
import { requireAdmin } from '../utils/admin-auth.js';

const router = express.Router();
const DATABASE_TABLES = [
  'admins',
  'attendance',
  'branches',
  'classes',
  'courses',
  'faculties',
  'rooms',
  'sessions',
  'slots',
  'students',
  'students_mapping',
  'subjects',
  'timetable',
  'timetable_classes',
];
const SENSITIVE_COLUMNS = {
  admins: new Set(['password_hash']),
  faculties: new Set(['password_hash']),
  students: new Set(['password_hash', 'face_embedding']),
};

router.get('/database/tables', requireAdmin, async (req, res) => {
  try {
    const tables = await Promise.all(
      DATABASE_TABLES.map(async name => {
        const metadata = await getTableMetadata(name);
        const count = await dbGet(
          `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
        );
        return { name, rowCount: count.count, columns: metadata.columns };
      }),
    );
    return res.json({ tables });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.get('/database/tables/:table/rows', requireAdmin, async (req, res) => {
  const table = getAllowedTable(req.params.table);
  if (!table)
    return res.status(404).json({ ok: false, error: 'table_not_found' });

  try {
    const metadata = await getTableMetadata(table);
    const visibleColumns = metadata.columns.filter(column => !column.sensitive);
    const search = String(req.query.search || '').trim();
    const page = Math.max(0, Number.parseInt(req.query.page, 10) || 0);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.pageSize, 10) || 50),
    );
    const where = search
      ? ` WHERE ${visibleColumns.map(column => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`).join(' OR ')}`
      : '';
    const params = search ? visibleColumns.map(() => `%${search}%`) : [];
    const total = await dbGet(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}${where}`,
      params,
    );
    const primaryKey = metadata.columns.find(column => column.primaryKey);
    const order = primaryKey
      ? ` ORDER BY ${quoteIdentifier(primaryKey.name)}`
      : '';
    const rows = await dbAll(
      `SELECT ${visibleColumns.map(column => quoteIdentifier(column.name)).join(', ')} FROM ${quoteIdentifier(table)}${where}${order} LIMIT ? OFFSET ?`,
      [...params, pageSize, page * pageSize],
    );
    return res.json({ rows, total: total.count, page, pageSize });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.post('/database/tables/:table/rows', requireAdmin, async (req, res) => {
  const table = getAllowedTable(req.params.table);
  if (!table)
    return res.status(404).json({ ok: false, error: 'table_not_found' });

  try {
    const metadata = await getTableMetadata(table);
    const values = await validateValues(
      table,
      req.body?.values,
      metadata,
      true,
    );
    if (!values.length)
      return res.status(400).json({ ok: false, error: 'empty_row' });

    const columns = values.map(([name]) => quoteIdentifier(name));
    const placeholders = values.map(() => '?');
    const result = await dbRun(
      `INSERT INTO ${quoteIdentifier(table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values.map(([, value]) => value),
    );
    return res.status(201).json({ ok: true, id: result.lastID });
  } catch (err) {
    if (err.status)
      return res.status(err.status).json({ ok: false, error: err.message });
    if (err.code === 'SQLITE_CONSTRAINT')
      return res
        .status(409)
        .json({ ok: false, error: 'row_conflict_or_invalid_reference' });
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
});

router.put(
  '/database/tables/:table/rows/:id',
  requireAdmin,
  async (req, res) => {
    const table = getAllowedTable(req.params.table);
    if (!table)
      return res.status(404).json({ ok: false, error: 'table_not_found' });

    try {
      const metadata = await getTableMetadata(table);
      const primaryKey = metadata.columns.find(column => column.primaryKey);
      if (!primaryKey)
        return res.status(400).json({ ok: false, error: 'table_not_editable' });
      const existing = await dbGet(
        `SELECT ${quoteIdentifier(primaryKey.name)} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(primaryKey.name)} = ?`,
        [req.params.id],
      );
      if (!existing)
        return res.status(404).json({ ok: false, error: 'row_not_found' });

      const values = await validateValues(
        table,
        req.body?.values,
        metadata,
        false,
      );
      if (!values.length)
        return res.status(400).json({ ok: false, error: 'empty_row' });
      const assignments = values.map(
        ([name]) => `${quoteIdentifier(name)} = ?`,
      );
      const result = await dbRun(
        `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${quoteIdentifier(primaryKey.name)} = ?`,
        [...values.map(([, value]) => value), req.params.id],
      );
      if (!result.changes)
        return res.status(404).json({ ok: false, error: 'row_not_found' });
      return res.json({ ok: true });
    } catch (err) {
      if (err.status)
        return res.status(err.status).json({ ok: false, error: err.message });
      if (err.code === 'SQLITE_CONSTRAINT')
        return res
          .status(409)
          .json({ ok: false, error: 'row_conflict_or_invalid_reference' });
      console.error(err);
      return res.status(500).json({ ok: false, error: 'database_error' });
    }
  },
);

router.get('/stats', (req, res) => {
  db.get(
    `
    SELECT
      (SELECT COUNT(*) FROM students WHERE active = 1) AS students,
      (SELECT COUNT(*) FROM faculties) AS faculty,
      (SELECT COUNT(*) FROM sessions WHERE end_time IS NULL) AS liveSessions,
      (SELECT COUNT(*) FROM attendance WHERE marked_at IS NOT NULL) AS attendance
    `,
    (err, stats) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }

      return res.json({ ok: true, stats });
    },
  );
});

function getAllowedTable(name) {
  return DATABASE_TABLES.includes(name) ? name : null;
}

async function getTableMetadata(table) {
  const [columns, foreignKeys] = await Promise.all([
    dbAll(`PRAGMA table_info(${quoteIdentifier(table)})`),
    dbAll(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`),
  ]);
  const described = await Promise.all(
    columns.map(async column => {
      const foreignKey = foreignKeys.find(key => key.from === column.name);
      return {
        name: column.name,
        type: column.type || 'TEXT',
        primaryKey: column.pk > 0,
        required: column.notnull === 1,
        defaultValue: column.dflt_value,
        sensitive: SENSITIVE_COLUMNS[table]?.has(column.name) || false,
        autoGenerated:
          column.pk > 0 && !foreignKey && /INT/i.test(column.type || ''),
        foreignKey: foreignKey
          ? {
              table: foreignKey.table,
              column: foreignKey.to,
              options: await getReferenceOptions(foreignKey.table),
            }
          : null,
      };
    }),
  );

  // timetable_classes has no primary key (on purpose, see schema.sql). SQLite still gives
  // every such row a hidden rowid, so it is shown as the key. That is what lets the
  // generic edit screen address one row.
  if (!described.some(column => column.primaryKey)) {
    described.unshift({
      name: 'rowid',
      type: 'INTEGER',
      primaryKey: true,
      required: false,
      defaultValue: null,
      sensitive: false,
      autoGenerated: true,
      foreignKey: null,
    });
  }
  return { columns: described };
}

async function getReferenceOptions(table) {
  const queries = {
    courses: `SELECT id AS value, name || ' (' || abbr || ')' AS label FROM courses ORDER BY name`,
    branches: `SELECT branches.id AS value, branches.name || ' (' || branches.abbr || ')' AS label FROM branches ORDER BY branches.name`,
    rooms: `SELECT id AS value, block || ' / ' || number AS label FROM rooms ORDER BY block, number`,
    slots: `SELECT id AS value, label || ' / ' || start_time AS label FROM slots ORDER BY id`,
    subjects: `SELECT id AS value, name || ' (' || code || ')' AS label FROM subjects ORDER BY name`,
    classes: `SELECT classes.id AS value, courses.abbr || ' / ' || branches.abbr || ' / semester ' || classes.semester || ' / ' || classes.section || ' / ' || classes.academic_session AS label FROM classes JOIN branches ON branches.id = classes.branch_id JOIN courses ON courses.id = branches.course_id ORDER BY courses.abbr, branches.abbr, classes.semester, classes.section`,
    faculties: `SELECT id AS value, name || ' (' || abbr || ')' AS label FROM faculties ORDER BY name`,
    students: `SELECT id AS value, name || ' / ' || COALESCE(roll_number, username) AS label FROM students ORDER BY name`,
    timetable: `SELECT timetable.id AS value, timetable.day || ' / ' || slots.label || ' / ' || subjects.abbr || ' / ' || COALESCE(rooms.number, 'no room') || ' / from ' || timetable.valid_from AS label FROM timetable JOIN slots ON slots.id = timetable.slot_id JOIN subjects ON subjects.id = timetable.subject_id LEFT JOIN rooms ON rooms.id = timetable.room_id ORDER BY timetable.day, slots.id, timetable.id`,
    sessions: `SELECT id AS value, session_code || ' / ' || date AS label FROM sessions ORDER BY id`,
  };
  const query = queries[table];
  if (!query) throw new Error(`Missing reference label query for ${table}`);
  return dbAll(query);
}

async function validateValues(table, input, metadata, isInsert) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw requestError(400, 'invalid_row');
  const columnMap = new Map(
    metadata.columns.map(column => [column.name, column]),
  );
  const entries = [];
  for (const [name, rawValue] of Object.entries(input)) {
    const column = columnMap.get(name);
    if (!column) throw requestError(400, 'unknown_column');
    if (column.primaryKey && (!isInsert || column.autoGenerated))
      throw requestError(400, 'primary_key_is_immutable');
    if (rawValue === '' && column.sensitive) continue;
    // Binary data (the face template) is written by the student routes, not typed in here.
    if (/BLOB/i.test(column.type)) throw requestError(400, 'blob_not_editable');
    if (rawValue === '' && !column.required) {
      entries.push([name, null]);
      continue;
    }
    if (rawValue === null || rawValue === undefined) {
      if (column.required) throw requestError(400, 'required_value_missing');
      entries.push([name, null]);
      continue;
    }
    if (column.foreignKey) {
      const targetMeta = await getTableMetadata(column.foreignKey.table);
      const targetKey = targetMeta.columns.find(
        target => target.name === column.foreignKey.column,
      );
      const exists = await dbGet(
        `SELECT 1 AS found FROM ${quoteIdentifier(column.foreignKey.table)} WHERE ${quoteIdentifier(column.foreignKey.column)} = ?`,
        [rawValue],
      );
      if (!exists) throw requestError(400, 'invalid_reference');
      if (/INT/i.test(targetKey?.type || '')) {
        const numericValue = Number(rawValue);
        if (!Number.isInteger(numericValue))
          throw requestError(400, 'invalid_reference');
        entries.push([name, numericValue]);
        continue;
      }
    }
    if (/INT/i.test(column.type)) {
      const numericValue = Number(rawValue);
      if (!Number.isInteger(numericValue))
        throw requestError(400, 'invalid_value');
      entries.push([name, numericValue]);
    } else {
      entries.push([name, String(rawValue)]);
    }
  }
  return entries;
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

export default router;
