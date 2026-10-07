// timetable-draft.js - the timetable is edited as ONE shared draft (with undo / redo) and only
// reaches the live tables when it is published with an effective date. Every publish becomes a
// "version" (the date it took effect).
import { dbAll, dbGet, dbRun, withTransaction } from './db.js';
import { addDays, isValidDate, todayLocal } from './dates.js';
import { HttpError } from '../routes/admin/common.js';

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const MAX_HISTORY = 200;

const ready = dbRun(`CREATE TABLE IF NOT EXISTS timetable_draft (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_date TEXT NOT NULL,
  base_json TEXT NOT NULL,
  history_json TEXT NOT NULL,
  pos INTEGER NOT NULL,
  next_n INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)`);

const sig = r => JSON.stringify([r.day, r.slotId, r.subjectId, r.facultyId ?? null, r.roomId ?? null,
  r.links.map(l => `${l.classId}:${l.batch || ''}`).sort()]);

// ---------------- versions ----------------
// A version starts on a date when rows began or ended (one-day arranged classes are not versions).
export async function versionDates() {
  await ready;
  const rows = await dbAll(
    `SELECT valid_from AS d FROM timetable WHERE valid_to IS NULL OR valid_to > valid_from
     UNION SELECT date(valid_to, '+1 day') FROM timetable WHERE valid_to > valid_from
     ORDER BY d DESC`,
  );
  return rows.map(r => r.d);
}

export async function liveRows(date) {
  const where = `valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)`;
  const rows = await dbAll(
    `SELECT id, day, slot_id AS slotId, subject_id AS subjectId, faculty_id AS facultyId, room_id AS roomId,
            valid_from AS validFrom, valid_to AS validTo FROM timetable WHERE ${where} ORDER BY id`, [date, date]);
  if (!rows.length) return [];
  const links = await dbAll(
    `SELECT timetable_id AS tid, class_id AS classId, batch FROM timetable_classes
     WHERE timetable_id IN (SELECT id FROM timetable WHERE ${where})`, [date, date]);
  const byId = new Map();
  for (const l of links) byId.set(l.tid, [...(byId.get(l.tid) || []), { classId: l.classId, batch: l.batch }]);
  return rows.map(r => ({ ...r, origin: r.id, id: `o${r.id}`, links: byId.get(r.id) || [] }));
}

// ---------------- lookups (labels for messages and the grid) ----------------
export async function lookups() {
  const [slots, rooms, subjects, faculties, classes] = await Promise.all([
    dbAll(`SELECT id, label FROM slots`),
    dbAll(`SELECT id, block || '-' || number AS label FROM rooms`),
    dbAll(`SELECT id, abbr, name FROM subjects`),
    dbAll(`SELECT id, abbr FROM faculties`),
    dbAll(`SELECT c.id, c.room_id AS roomId, b.abbr || ' ' || c.semester || c.section AS label
           FROM classes c JOIN branches b ON b.id = c.branch_id`),
  ]);
  const m = (list, f = x => x) => new Map(list.map(x => [x.id, f(x)]));
  return { slot: m(slots, s => s.label), room: m(rooms, r => r.label), subj: m(subjects), fac: m(faculties, f => f.abbr), cls: m(classes) };
}

// ---------------- the draft record ----------------
async function readDraft() {
  await ready;
  const r = await dbGet(`SELECT * FROM timetable_draft WHERE id = 1`);
  return r && { baseDate: r.base_date, base: JSON.parse(r.base_json), history: JSON.parse(r.history_json), pos: r.pos, nextN: r.next_n };
}

export async function working() {
  const d = await readDraft();
  if (d) return { exists: true, ...d, rows: d.pos === 0 ? d.base : d.history[d.pos - 1] };
  const baseDate = (await versionDates())[0] || todayLocal();
  const base = await liveRows(baseDate);
  return { exists: false, baseDate, base, history: [], pos: 0, nextN: 1, rows: base };
}

async function store(w, history, pos, nextN) {
  await dbRun(
    `INSERT INTO timetable_draft (id, base_date, base_json, history_json, pos, next_n, updated_at) VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET base_date = excluded.base_date, base_json = excluded.base_json, history_json = excluded.history_json,
       pos = excluded.pos, next_n = excluded.next_n, updated_at = excluded.updated_at`,
    [w.baseDate, JSON.stringify(w.base), JSON.stringify(history), pos, nextN]);
}

// Apply fn(rows, newId) -> new rows, as one undoable step.
export async function mutateNow(fn) {
  const w = await working();
  let nextN = w.nextN;
  const rows = await fn(w.rows.map(r => ({ ...r, links: r.links.map(l => ({ ...l })) })), () => `n${nextN++}`, w);
  const history = w.history.slice(0, w.pos).concat([rows]);
  let pos = w.pos + 1;
  while (history.length > MAX_HISTORY) { history.shift(); pos--; }
  await store(w, history, pos, nextN);
}
export const mutate = fn => withTransaction(() => mutateNow(fn));

export function step(delta) {
  return withTransaction(async () => {
    const w = await working();
    const pos = w.pos + delta;
    if (!w.exists || pos < 0 || pos > w.history.length) throw new HttpError(409, 'nothing_to_do', delta < 0 ? 'Nothing to undo.' : 'Nothing to redo.');
    await store(w, w.history, pos, w.nextN);
  });
}

export async function discard() {
  await ready;
  await dbRun(`DELETE FROM timetable_draft WHERE id = 1`);
}

// ---------------- diff ----------------
export function diff(base, rows) {
  const before = new Map(base.map(r => [r.id, r]));
  const after = new Map(rows.map(r => [r.id, r]));
  return {
    added: rows.filter(r => !before.has(r.id)),
    removed: base.filter(r => !after.has(r.id)),
    changed: rows.filter(r => before.has(r.id) && sig(before.get(r.id)) !== sig(r)).map(r => ({ before: before.get(r.id), after: r })),
  };
}

export async function status() {
  const w = await working();
  if (!w.exists) return null;
  const d = diff(w.base, w.rows);
  return { baseDate: w.baseDate, canUndo: w.pos > 0, canRedo: w.pos < w.history.length, changes: d.added.length + d.removed.length + d.changed.length };
}

// ---------------- presentation ----------------
export function present(r, L) {
  return {
    id: r.id, day: r.day, slotId: r.slotId, subjectId: r.subjectId,
    subject: L.subj.get(r.subjectId)?.abbr, subjectName: L.subj.get(r.subjectId)?.name,
    facultyId: r.facultyId, faculty: L.fac.get(r.facultyId) ?? null,
    roomId: r.roomId, room: L.room.get(r.roomId) ?? null,
    validFrom: r.validFrom, validTo: r.validTo, sessionCount: 0,
    links: r.links.map(l => ({ classId: l.classId, batch: l.batch, label: L.cls.get(l.classId)?.label })),
  };
}

export const inScope = (r, query, L) => (query.roomId
  ? r.links.some(l => L.cls.get(l.classId)?.roomId === Number(query.roomId))
  : query.facultyId ? r.facultyId === Number(query.facultyId) : false);

const describe = (r, L) => `${L.subj.get(r.subjectId)?.abbr}${r.facultyId ? ` (${L.fac.get(r.facultyId)})` : ''}${r.roomId ? ` · ${L.room.get(r.roomId)}` : ''}`;
const classesText = (r, L) => r.links.map(l => `${L.cls.get(l.classId)?.label}${l.batch ? '/' + l.batch : ''}`).join(', ');

// Human-readable change list, merging consecutive periods of the same change.
export function summarise(d, L) {
  const groups = new Map();
  const add = (type, r, text) => {
    const key = `${type}|${r.day}|${text}`;
    const g = groups.get(key) || { type, day: r.day, text, slots: [] };
    g.slots.push(r.slotId);
    groups.set(key, g);
  };
  d.added.forEach(r => add('added', r, `${classesText(r, L)} — ${describe(r, L)}`));
  d.removed.forEach(r => add('removed', r, `${classesText(r, L)} — ${describe(r, L)}`));
  d.changed.forEach(({ before, after }) => add('changed', after, `${classesText(after, L)} — ${describe(before, L)} → ${describe(after, L)}`));
  return [...groups.values()].map(g => {
    const slots = [...new Set(g.slots)].sort((a, b) => a - b).map(id => L.slot.get(id));
    return { type: g.type, text: `${g.day.slice(0, 3)} · ${slots.length > 1 ? `${slots[0]}–${slots.at(-1)}` : slots[0]} · ${g.text}` };
  });
}

// ---------------- clashes ----------------
export function conflictsFor(rows, L, { day, slotIds, facultyId, roomId, links, excludeIds = [] }) {
  const skip = new Set(excludeIds);
  const out = [];
  for (const slotId of slotIds) {
    const at = rows.filter(r => r.day === day && r.slotId === slotId && !skip.has(r.id));
    const where = ` ${L.slot.get(slotId) || ''}`;
    for (const r of at) {
      const subject = L.subj.get(r.subjectId)?.abbr;
      if (facultyId && r.facultyId === facultyId)
        out.push({ type: 'faculty', slotId, message: `Faculty ${L.fac.get(facultyId)} already teaches ${subject} (${classesText(r, L)}) in${where}.` });
      if (roomId && r.roomId === roomId)
        out.push({ type: 'room', slotId, message: `Room ${L.room.get(roomId)} is already used for ${subject} (${classesText(r, L)}) in${where}.` });
      for (const link of links) {
        const batch = link.batch || null;
        if (r.links.some(x => x.classId === link.classId && (!x.batch || !batch || x.batch === batch)))
          out.push({ type: 'class', slotId, message: `${L.cls.get(link.classId)?.label}${batch ? '/' + batch : ''} already has ${subject}${r.facultyId ? ' with ' + L.fac.get(r.facultyId) : ''} in${where}.` });
      }
    }
  }
  return out;
}

export const conflictError = conflicts => new HttpError(409, 'conflict', conflicts[0].message, { conflicts });

// ---------------- publish ----------------
export function publish(effectiveFrom) {
  return withTransaction(async () => {
    if (!isValidDate(effectiveFrom)) throw new HttpError(400, 'invalid_value', 'Choose the date this timetable takes effect.');
    const w = await working();
    if (!w.exists) throw new HttpError(409, 'no_draft', 'There is no draft to publish.');
    const latest = (await versionDates())[0];
    if (latest && effectiveFrom < latest)
      throw new HttpError(409, 'invalid_value', `The newest version already starts on ${latest}. Choose that date or a later one.`);
    // The live timetable must still be what the draft started from.
    const live = await liveRows(w.baseDate);
    if (live.length !== w.base.length || live.some(r => !w.base.some(b => b.id === r.id)))
      throw new HttpError(409, 'stale_draft', 'The live timetable changed after this draft was started. Discard the draft and redo your changes.');
    const L = await lookups();
    for (const r of w.rows) {
      const found = conflictsFor(w.rows, L, { day: r.day, slotIds: [r.slotId], facultyId: r.facultyId, roomId: r.roomId, links: r.links, excludeIds: [r.id] });
      if (found.length) throw conflictError(found);
    }
    const d = diff(w.base, w.rows);
    const endedValidTo = new Map();
    // 1) end or remove the old rows that are replaced / deleted
    for (const old of [...d.removed, ...d.changed.map(c => c.before)]) {
      const row = await dbGet(`SELECT valid_from, valid_to FROM timetable WHERE id = ?`, [old.origin]);
      if (!row) continue;
      endedValidTo.set(old.id, row.valid_to);
      if (row.valid_from >= effectiveFrom) {
        const n = (await dbGet(`SELECT COUNT(*) AS n FROM sessions WHERE timetable_id = ?`, [old.origin])).n;
        if (n) throw new HttpError(409, 'has_sessions', 'Attendance has already been taken for a period you changed, so the change has to start on a later date.');
        await dbRun(`DELETE FROM timetable_classes WHERE timetable_id = ?`, [old.origin]);
        await dbRun(`DELETE FROM timetable WHERE id = ?`, [old.origin]);
      } else {
        await dbRun(`UPDATE timetable SET valid_to = ? WHERE id = ?`, [addDays(effectiveFrom, -1), old.origin]);
      }
    }
    // 2) insert the new and changed rows
    for (const r of [...d.added, ...d.changed.map(c => c.after)]) {
      const res = await dbRun(
        `INSERT INTO timetable (room_id, day, slot_id, subject_id, faculty_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.roomId ?? null, r.day, r.slotId, r.subjectId, r.facultyId ?? null, effectiveFrom, endedValidTo.get(r.id) ?? null]);
      for (const l of r.links)
        await dbRun(`INSERT INTO timetable_classes (timetable_id, class_id, batch) VALUES (?, ?, ?)`, [res.lastID, l.classId, l.batch]);
    }
    await dbRun(`DELETE FROM timetable_draft WHERE id = 1`);
    return { effectiveFrom, changes: d.added.length + d.removed.length + d.changed.length };
  });
}
