import express from 'express';
import { dbAll } from '../../utils/db.js';
import { isValidDate, todayLocal } from '../../utils/dates.js';
import { HttpError, wrap, clean } from './common.js';
import {
  DAYS, versionDates, liveRows, lookups, working, mutate, step, discard, diff, status,
  present, inScope, summarise, conflictsFor, conflictError, publish,
} from '../../utils/timetable-draft.js';

const router = express.Router();
const intOrNull = v => (clean(v) === null ? null : Number(v));

router.get('/meta', wrap(async (req, res) => {
  const [slots, rooms, subjects, faculties, classes, versions, draft] = await Promise.all([
    dbAll(`SELECT id, label, start_time AS start, end_time AS end FROM slots ORDER BY start_time`),
    dbAll(`SELECT id, block || '-' || number AS label, type FROM rooms ORDER BY block, number`),
    dbAll(`SELECT id, code, abbr, name, takes_attendance AS takesAttendance FROM subjects ORDER BY id`),
    dbAll(`SELECT id, abbr, name FROM faculties ORDER BY abbr`),
    dbAll(`SELECT c.id, b.abbr || ' Sem ' || c.semester || ' ' || c.section AS label,
                  b.abbr || ' ' || c.semester || c.section AS short,
                  c.academic_session AS session, c.room_id AS roomId,
                  b.name AS branchName, b.abbr AS branchAbbr, c.semester, c.section, c.counsellor,
                  (SELECT r.block || '-' || r.number FROM rooms r WHERE r.id = c.room_id) AS roomLabel
           FROM classes c JOIN branches b ON b.id = c.branch_id
           ORDER BY c.academic_session DESC, b.abbr, c.semester, c.section`),
    versionDates(),
    status(),
  ]);
  res.json({ ok: true, days: DAYS, slots, rooms, subjects, faculties, classes, today: todayLocal(), versions, latest: versions[0] || null, draft });
}));

// Timetable of one classroom / faculty: a published version (?date=) or the draft (?draft=1).
router.get('/grid', wrap(async (req, res) => {
  if (!req.query.roomId && !req.query.facultyId) return res.json({ ok: true, rows: [], removed: [] });
  const L = await lookups();
  if (req.query.draft) {
    const w = await working();
    const d = diff(w.base, w.rows);
    const added = new Set(d.added.map(r => r.id));
    const changed = new Map(d.changed.map(c => [c.after.id, c.before]));
    const text = r => `${L.subj.get(r.subjectId)?.abbr}${r.facultyId ? ` (${L.fac.get(r.facultyId)})` : ''}${r.roomId ? ` · ${L.room.get(r.roomId)}` : ''}`;
    const rows = w.rows.filter(r => inScope(r, req.query, L)).map(r => ({
      ...present(r, L),
      change: added.has(r.id) ? 'new' : changed.has(r.id) ? 'changed' : undefined,
      was: changed.has(r.id) ? text(changed.get(r.id)) : undefined,
    }));
    const removed = d.removed.filter(r => inScope(r, req.query, L)).map(r => present(r, L));
    return res.json({ ok: true, rows, removed, draft: true });
  }
  const date = isValidDate(req.query.date) ? req.query.date : todayLocal();
  const rows = (await liveRows(date)).filter(r => inScope(r, req.query, L)).map(r => present(r, L));
  res.json({ ok: true, rows, removed: [] });
}));

// ---------------- draft ----------------
router.get('/draft', wrap(async (req, res) => res.json({ ok: true, draft: await status() })));

router.get('/draft/changes', wrap(async (req, res) => {
  const w = await working();
  const L = await lookups();
  const latest = (await versionDates())[0] || null;
  res.json({ ok: true, baseDate: w.baseDate, latest, today: todayLocal(), changes: summarise(diff(w.base, w.rows), L) });
}));

router.post('/draft/undo', wrap(async (req, res) => { await step(-1); res.json({ ok: true, draft: await status() }); }));
router.post('/draft/redo', wrap(async (req, res) => { await step(1); res.json({ ok: true, draft: await status() }); }));
router.delete('/draft', wrap(async (req, res) => { await discard(); res.json({ ok: true }); }));
router.post('/draft/publish', wrap(async (req, res) => res.json({ ok: true, ...(await publish(req.body?.effectiveFrom)) })));

// ---------------- entries (all of these edit the draft) ----------------
function parseEntry(body, { needSubject = true, needDay = true } = {}) {
  if (needDay && !DAYS.includes(body.day)) throw new HttpError(400, 'invalid_value', 'Choose a weekday.');
  const links = (body.links || []).map(l => ({ classId: Number(l.classId), batch: clean(l.batch) }));
  if (!links.length || links.some(l => !Number.isInteger(l.classId))) throw new HttpError(400, 'invalid_value', 'Choose at least one class.');
  const subjectId = intOrNull(body.subjectId);
  if (needSubject && !subjectId) throw new HttpError(400, 'required_value_missing', 'Choose a subject.');
  return { day: body.day, links, subjectId, facultyId: intOrNull(body.facultyId), roomId: intOrNull(body.roomId) };
}

router.post('/check', wrap(async (req, res) => {
  const entry = parseEntry(req.body, { needSubject: false });
  const slotIds = (req.body.slotIds || []).map(Number);
  const w = await working();
  res.json({ ok: true, conflicts: conflictsFor(w.rows, await lookups(), { ...entry, slotIds, excludeIds: (req.body.excludeIds || []).map(String) }) });
}));

// Create one entry; several slotIds (a lab) create one row per period.
router.post('/entry', wrap(async (req, res) => {
  const entry = parseEntry(req.body);
  const slotIds = (req.body.slotIds || []).map(Number);
  if (!slotIds.length || slotIds.some(n => !Number.isInteger(n))) throw new HttpError(400, 'invalid_value', 'Choose a period.');
  const L = await lookups();
  await mutate((rows, newId) => {
    const found = conflictsFor(rows, L, { ...entry, slotIds });
    if (found.length) throw conflictError(found);
    return [...rows, ...slotIds.map(slotId => ({ id: newId(), origin: null, day: entry.day, slotId, subjectId: entry.subjectId, facultyId: entry.facultyId, roomId: entry.roomId, links: entry.links }))];
  });
  res.status(201).json({ ok: true, draft: await status() });
}));

// Edit a group of rows (one entry that may span several periods).
router.put('/entry', wrap(async (req, res) => {
  const ids = (req.body.ids || []).map(String);
  if (!ids.length) throw new HttpError(400, 'invalid_value', 'Nothing to edit.');
  const entry = parseEntry(req.body, { needDay: false });
  const L = await lookups();
  await mutate(rows => {
    for (const id of ids) {
      const row = rows.find(r => r.id === id);
      if (!row) throw new HttpError(404, 'not_found', 'This entry no longer exists. Reload the timetable.');
      const found = conflictsFor(rows, L, { day: row.day, slotIds: [row.slotId], ...entry, excludeIds: ids });
      if (found.length) throw conflictError(found);
    }
    return rows.map(r => (ids.includes(r.id) ? { ...r, subjectId: entry.subjectId, facultyId: entry.facultyId, roomId: entry.roomId, links: entry.links } : r));
  });
  res.json({ ok: true, draft: await status() });
}));

router.delete('/entry', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  await mutate(rows => rows.filter(r => !ids.includes(r.id)));
  res.json({ ok: true, draft: await status() });
}));

export default router;
