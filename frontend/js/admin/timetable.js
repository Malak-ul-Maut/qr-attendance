// timetable.js - replica of the department's printed timetable sheet, per classroom (section),
// with add / edit / delete and live clash detection. Classroom view is editable; faculty view is read-only.
import { $, h, api, askDelete, setBusy, setBox, errorText, fillSelect, showToast, createCombobox, announce } from './core.js';
import { openImport } from './import.js';

let meta = null;
let rows = [];
let removed = [];
let mode = 'room';
let loaded = false;
let rooms = [];
let space = 'published'; // 'draft' (editable) or 'published' (read-only versions)
let pendingCell = null; // the cell last edited, so focus can return to it after the sheet is redrawn

const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const clock = t => { const hr = Number(t.slice(0, 2)); return `${String(hr > 12 ? hr - 12 : hr).padStart(2, '0')}:${t.slice(3)}`; };
// Colours taken from the printed sheet. Unknown subjects borrow a spare shade from the same palette.
const COLORS = { DBMS: '#ffff00', WT: '#ffd966', DAA: '#d9ead3', OOSD: '#fff2cc', MLT: '#a8e6c3', SOS: '#cfe2f3', APT: '#cfe2f3', COI: '#bf9000', CPP: '#f8d7d7' };
const SPARE = ['#ffff00', '#ffd966', '#d9ead3', '#fff2cc', '#a8e6c3', '#cfe2f3', '#f8d7d7', '#bf9000'];
const colorOf = subject => COLORS[subject.abbr] || SPARE[Math.max(0, meta.subjects.findIndex(x => x.id === subject.id)) % SPARE.length];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = iso => (iso ? `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
const slotRange = slots => (slots.length > 1 ? `${slots[0].label} – ${slots.at(-1).label}` : slots[0].label);
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
// "DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING", built from the branch names of the classes on the sheet
const deptTitle = classes => {
  const names = [...new Set(classes.map(c => c.branchName).filter(Boolean))];
  return names.length ? `DEPARTMENT OF ${names.map(n => n.toUpperCase().replace(/ AND /g, ' & ')).join(' / ')}` : 'DEPARTMENT TIMETABLE';
};
const subjectOf = id => meta.subjects.find(x => x.id === id);

const sel = () => (space === 'draft' ? 'draft' : $('#ttDate').value);
const TT = '/api/admin/timetable';
const viewParam = () => (sel() === 'draft' ? 'draft=1' : `date=${sel()}`);
const onLatest = () => !meta.versions.length || $('#ttDate').value === meta.latest;
// Every edit goes into the draft; published versions are read-only (switch to Draft to change them).
const canEdit = () => mode === 'room' && space === 'draft';

// One option per classroom that is somebody's home room (A–E), so shared rooms (D) appear once.
function buildRooms() {
  const map = new Map();
  for (const c of meta.classes) {
    if (!c.roomId) continue;
    const r = map.get(c.roomId) || { id: c.roomId, label: c.roomLabel, sections: new Set(), classes: [] };
    r.sections.add(c.section);
    r.classes.push(c);
    map.set(c.roomId, r);
  }
  rooms = [...map.values()].map(r => ({ ...r, sections: [...r.sections].sort() }))
    .sort((a, b) => a.sections[0].localeCompare(b.sections[0]) || a.label.localeCompare(b.label));
}

let printRoom = null;
// "CSE-5A (F-307)"; classes sharing a room: "DS/AIML-5D (F-403)".
function roomTitle(room) {
  const groups = new Map();
  for (const c of [...room.classes].sort((a, b) => a.id - b.id)) {
    const k = `${c.semester}${c.section}`;
    groups.set(k, [...(groups.get(k) || []), c.branchAbbr]);
  }
  const names = [...groups].map(([k, branches]) => `${[...new Set(branches)].join('/')}-${k}`).join(' + ');
  return `${names} (${room.label})`;
}
const currentRoom = () => mode !== 'room' ? undefined : printRoom || rooms.find(r => String(r.id) === $('#ttTarget').value);
const homeClasses = () => currentRoom()?.classes || [];

function fillTargets() {
  const select = $('#ttTarget');
  $('label[for="ttTarget"]').textContent = mode === 'room' ? 'Classroom' : 'Faculty';
  if (mode === 'room') fillSelect(select, rooms.map(r => ({ value: r.id, label: roomTitle(r) })));
  else fillSelect(select, meta.faculties.map(f => ({ value: f.id, label: `${f.abbr} – ${f.name}` })));
  $('#ttHint').textContent = mode === 'faculty' ? 'Read-only. Click a period to open its classroom.' : space === 'draft' ? 'Click a period to edit it, or an empty period to add a class.' : 'Read-only. Switch to Draft to make changes.';
}

function fillVersions(prefer) {
  const select = $('#ttDate');
  const previous = select.value;
  const current = meta.versions.find(d => d <= meta.today);
  const tag = d => (d === current ? ' (current)' : d > meta.today ? ' (upcoming)' : '');
  const options = meta.versions.map(d => ({ value: d, label: `w.e.f. ${fmtDate(d)}${tag(d)}` }));
  if (!options.length) options.push({ value: meta.today, label: 'No published timetable yet' });
  fillSelect(select, options);
  const wanted = [prefer, previous].find(v => v && v !== 'draft' && options.some(o => String(o.value) === v));
  select.value = wanted ?? (current && options.some(o => o.value === current) ? current : String(options[0].value));
}

function syncSpace() {
  document.querySelectorAll('#ttSpaceSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.space === space)));
  $('#ttVersionField').hidden = space === 'draft';
  const draftBtn = $('#ttSpaceSeg [data-space="draft"]');
  const n = meta?.draft?.changes || 0;
  draftBtn.textContent = n ? `Draft (${n})` : 'Draft';
  draftBtn.setAttribute('aria-label', n ? `Draft, ${n} unpublished change${n === 1 ? '' : 's'}` : 'Draft');
  $('#ttCopyDayBtn').disabled = !canEdit();
  $('#ttCopyDayBtn').title = canEdit() ? '' : mode === 'room' ? 'Switch to Draft to copy a day' : 'Copy day works in the classroom view';
}
function setSpace(next) {
  if (space === next) return;
  space = next;
  fillTargets();
  syncSpace();
  loadGrid();
}

// Re-read rooms, versions and the draft state (also picks up rooms/classes created in Master).
async function refreshMeta({ prefer } = {}) {
  meta = await api(`${TT}/meta`);
  const previous = $('#ttTarget').value;
  buildRooms();
  fillTargets();
  if (previous && [...$('#ttTarget').options].some(o => o.value === previous)) $('#ttTarget').value = previous;
  fillVersions(prefer);
  updateToolbar();
}

function updateToolbar() {
  const d = meta.draft;
  $('#ttUndoBtn').disabled = !d?.canUndo;
  $('#ttRedoBtn').disabled = !d?.canRedo;
  $('#ttUndoBtn').title = d?.canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo';
  $('#ttRedoBtn').title = d?.canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo';
  syncSpace();
  const banner = $('#ttBanner');
  const button = (text, onclick, primary) => h('button', { class: `btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}`, type: 'button', text, onclick });
  if (space === 'draft') {
    banner.replaceChildren(
      h('span', { text: d?.changes ? `Draft: ${d.changes} unpublished change${d.changes === 1 ? '' : 's'} since ${fmtDate(d.baseDate)}. Nothing is live until you publish.` : d ? `Draft started from the ${fmtDate(d.baseDate)} version. No changes yet.` : `No changes yet. Your edits are saved to a draft that starts from ${meta.latest ? `the ${fmtDate(meta.latest)} version` : 'an empty timetable'}.` }),
      h('span', { class: 'adm-banner-actions' }, ...(d ? [button('Discard draft', discardDraft, false), button('Review & publish', openPublish, true)] : [])));
    banner.hidden = false;
  } else {
    banner.replaceChildren(
      h('span', { text: `Published timetable${onLatest() ? '' : ' (older version)'}: read-only.${d?.changes ? ` You have ${d.changes} unpublished change${d.changes === 1 ? '' : 's'} in the draft.` : ''}` }),
      h('span', { class: 'adm-banner-actions' },
        ...(!onLatest() ? [button('Go to latest version', () => { $('#ttDate').value = meta.latest; updateToolbar(); loadGrid(); }, false)] : []),
        ...(mode === 'room' ? [button(d ? 'Open draft' : 'Edit in draft', () => setSpace('draft'), true)] : [])));
    banner.hidden = false;
  }
}

export async function loadTimetable() {
  try {
    await refreshMeta();
  } catch {
    $('#ttGrid').replaceChildren(h('div', { class: 'adm-state', role: 'alert' }, h('strong', { text: 'Could not load the timetable' }), h('button', { class: 'btn btn-secondary', type: 'button', text: 'Try again', onclick: loadTimetable })));
    return;
  }
  if (!loaded) space = meta.draft ? 'draft' : 'published';
  loaded = true;
  fillTargets();
  syncSpace();
  buildPhoneBar();
  await loadGrid();
}

async function afterEdit() {
  space = 'draft'; // every edit lives in the draft, so that is where the person should land
  await refreshMeta();
  await loadGrid();
}

async function stepDraft(which) {
  try {
    await api(`${TT}/draft/${which}`, { method: 'POST' });
    await afterEdit();
    showToast(which === 'undo' ? 'Undone.' : 'Redone.', 'success');
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

function discardDraft() {
  askDelete({
    title: 'Discard the draft?',
    text: 'Every unpublished change is lost. The published timetable stays as it is.',
    run: async () => {
      await api(`${TT}/draft`, { method: 'DELETE' });
      space = 'published';
      await refreshMeta();
      showToast('Draft discarded.', 'success');
      loadGrid();
    },
  });
}

async function loadGrid() {
  const target = $('#ttTarget').value;
  updateToolbar();
  if (!target) {
    $('#ttGrid').replaceChildren(h('div', { class: 'adm-state' }, h('strong', { text: 'Nothing to show yet' }), h('span', { text: 'Create classes with a classroom in Setup → Term setup first.' })));
    return;
  }
  try {
    ({ rows, removed = [] } = await api(`${TT}/grid?${mode}Id=${target}&${viewParam()}`));
    renderGrid();
    restoreCellFocus();
  } catch (error) {
    $('#ttGrid').replaceChildren(h('div', { class: 'adm-state', role: 'alert' }, h('strong', { text: 'Could not load this timetable' }), h('span', { text: errorText(error) })));
  }
}

function goToRoom(classId) {
  const room = rooms.find(r => r.classes.some(c => c.id === classId));
  if (!room) return;
  mode = 'room';
  syncMode();
  fillTargets();
  $('#ttTarget').value = String(room.id);
  loadGrid();
}

function syncMode() {
  document.querySelectorAll('#ttModeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}

// After the sheet is redrawn the button that opened the editor is gone; put focus back on that cell (or the nearest one that day)
function restoreCellFocus() {
  if (!pendingCell || document.querySelector('dialog[open]')) return;
  const active = document.activeElement;
  if (active && active !== document.body && document.contains(active)) { pendingCell = null; return; }
  const cells = [...document.querySelectorAll(`#ttGrid [data-cell^="${pendingCell.day}|"]`)];
  const cell = cells.filter(c => Number(c.dataset.cell.split('|')[1]) <= pendingCell.start).at(-1) || cells[0];
  (cell?.querySelector('button') || $('#ttGrid')).focus();
  pendingCell = null;
}
document.addEventListener('close', event => { if (event.target.tagName === 'DIALOG') requestAnimationFrame(restoreCellFocus); }, true);

// ---------------- grid ----------------
const batchOf = row => row.links.find(link => link.batch)?.batch?.trim().toUpperCase() || null;
const classesText = row => row.links.map(link => link.label + (link.batch ? `/${link.batch}` : '')).join(', ');

function describe(row, home) {
  const batch = batchOf(row);
  const homeIds = new Set(homeClasses().map(c => c.id));
  const others = mode === 'room' ? row.links.filter(l => !homeIds.has(l.classId)) : [];
  const away = mode === 'room' ? row.room && row.room !== home : Boolean(row.room);
  const text = [row.subjectName + (batch ? ` ${batch}` : ''), row.faculty, away ? row.room : null, mode === 'faculty' ? classesText(row) : null].filter(Boolean).join(', ');
  return { batch, others, away, text: others.length ? `${text}, shared with ${others.map(l => l.label).join(', ')}` : text };
}

function partNode(member, editable, home, lab) {
  const row = member.rows[0];
  const { batch, others, away, text } = describe(row, home);
  const open = () => (editable ? openEditor({ entry: member }) : goToRoom(row.links[0].classId));
  const label = lab
    ? `${batch ? `${batch}: ` : ''}${row.subject}${row.faculty ? ` (${row.faculty})` : ''}${row.room ? ` - ${row.room}` : ''}`
    : null;
  return h('button', {
    class: `adm-part${lab ? ' adm-lab' : ''}`, type: 'button', title: text,
    'aria-label': `${editable ? 'Edit' : 'Open classroom for'} ${text}`, onclick: open,
  },
  ...(lab
    ? [h('span', { text: label })]
    : [h('span', { class: 'adm-l1', text: row.subject }),
      row.faculty ? h('span', { class: 'adm-l2', text: row.faculty }) : null,
      away ? h('span', { class: 'adm-l2', text: row.room }) : null,
      mode === 'faculty' ? h('span', { class: 'adm-l2', text: classesText(row) }) : null]),
  others.length ? h('span', { class: 'adm-shared', text: '⧉', title: `Shared with ${others.map(l => l.label).join(', ')}` }) : null);
}

function combineBatchPairs(entries) {
  const candidates = new Map();
  for (const entry of entries) {
    const row = entry.rows[0];
    const batch = batchOf(row);
    if (!['G1', 'G2'].includes(batch)) continue;
    const signature = JSON.stringify([row.links.map(l => l.classId).sort((a, b) => a - b), entry.rows.map(({ day, slotId }) => [day, slotId])]);
    const group = candidates.get(signature) || { G1: [], G2: [] };
    group[batch].push(entry);
    candidates.set(signature, group);
  }
  const combined = new Map();
  const consumed = new Set();
  for (const group of candidates.values()) {
    if (group.G1.length !== 1 || group.G2.length !== 1) continue;
    combined.set(group.G1[0], { ...group.G1[0], members: [group.G1[0], group.G2[0]] });
    consumed.add(group.G2[0]);
  }
  return entries.filter(entry => !consumed.has(entry)).map(entry => combined.get(entry) || entry);
}

const isLab = row => batchOf(row) !== null || /lab/i.test(row.subjectName);

// A row's identity: periods that match on all of these are one lesson (a lab covers 2 periods)
const rowKey = r => [r.subjectId, r.facultyId, r.roomId, r.links.map(l => `${l.classId}:${l.batch || ''}`).sort().join('+'), r.validFrom, r.validTo].join('|');
const lunchIndex = slots => slots.findIndex((s, i) => i < slots.length - 1 && toMin(slots[i + 1].start) - toMin(s.end) >= 20);

// One day cut into cells: consecutive periods with the same lesson are merged. Used by the sheet and the phone day list.
function daySegments(day, slots, lunchAfter) {
  const bySlot = slots.map(s => rows.filter(r => r.day === day && r.slotId === s.id));
  const sig = i => bySlot[i].map(rowKey).sort().join('#');
  const out = [];
  for (let i = 0; i < slots.length;) {
    const start = i;
    let span = 1;
    if (bySlot[i].length) while (i + span < slots.length && i + span - 1 !== lunchAfter && sig(i + span) === sig(i)) span++;
    const entries = bySlot[i].map(r => ({
      day, slotIdx: i,
      rows: [r, ...Array.from({ length: span - 1 }, (_, k) => bySlot[i + k + 1].find(x => rowKey(x) === rowKey(r)))],
    }));
    const shown = combineBatchPairs(entries);
    const first = bySlot[i][0];
    const subject = first && subjectOf(first.subjectId);
    const lab = shown.some(e => isLab((e.members ? e.members[0] : e).rows[0]));
    const bg = !first || lab || (subject && !subject.takesAttendance && !first.faculty) ? null : colorOf(subject);
    const flags = shown.flatMap(e => (e.members || [e]).map(m => m.rows[0]));
    const ghosts = first ? [] : removed.filter(r => r.day === day && r.slotId === slots[start].id);
    out.push({ start, span, shown, first, lab, bg, flags, ghosts, isNew: flags.some(r => r.change === 'new'), isChanged: flags.some(r => r.change === 'changed') });
    i += span;
  }
  return out;
}

const changeNote = ({ flags, isChanged, isNew, ghosts }) =>
  isChanged ? `Changed in this draft. Was: ${flags.find(r => r.change === 'changed').was}` : isNew ? 'Added in this draft' : ghosts.length ? 'Removed in this draft' : false;
const ghostNodes = ghosts => ghosts.map(r => h('span', { class: 'adm-ghost', text: `was ${r.subject}${r.faculty ? ` (${r.faculty})` : ''}`, title: 'Removed in this draft' }));

// ---- Phones: one day at a time (the 8-period sheet is 800px wide), with a switch to the full sheet ----
const phone = window.matchMedia('(max-width: 600px)');
let phoneView = 'day'; // 'day' | 'week'
let phoneDay = null;
const dayMode = () => phone.matches && phoneView === 'day';
function pickDay() {
  if (phoneDay && meta.days.includes(phoneDay)) return phoneDay;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  return meta.days.includes(today) ? today : meta.days[0];
}

function buildPhoneBar() {
  const day = pickDay();
  $('#ttDayBtns').replaceChildren(...meta.days.map(d => h('button', {
    type: 'button', 'data-day': d, 'aria-pressed': String(d === day), 'aria-label': d, text: d.slice(0, 3),
    onclick: () => { phoneDay = d; syncPhoneBar(); renderGrid(); },
  })));
  syncPhoneBar();
}
function syncPhoneBar() {
  const day = pickDay();
  const week = phoneView === 'week';
  $('#ttDayBtns').hidden = week;
  $('#ttDayBtns').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.day === day)));
  const toggle = $('#ttViewBtn');
  toggle.textContent = week ? 'Day view' : 'Week view';
  toggle.setAttribute('aria-pressed', String(week));
  $('#ttGrid').classList.toggle('adm-daymode', dayMode());
  $('#ttGrid').setAttribute('aria-label', dayMode() ? `Timetable for ${day}` : 'Weekly timetable');
  // keep the grid region keyboard-reachable only when it can actually scroll sideways
  $('#ttGrid').tabIndex = dayMode() ? -1 : 0;
}

function buildDayList(editable) {
  const slots = meta.slots;
  const day = pickDay();
  const lunchAfter = lunchIndex(slots);
  const home = currentRoom()?.label;
  const list = h('ol', { class: 'adm-day-list' });
  for (const seg of daySegments(day, slots, lunchAfter)) {
    const { start, span, shown, first, lab, bg, isNew, isChanged, ghosts } = seg;
    const covered = slots.slice(start, start + span);
    const short = covered.map(s => s.label.replace(/^Period\s*/i, 'P'));
    const time = h('span', { class: 'adm-di-time' },
      h('strong', { text: `${clock(covered[0].start)}–${clock(covered.at(-1).end)}` }),
      h('span', { text: short.length > 1 ? `${short[0]}–${short.at(-1)}` : short[0], title: slotRange(covered) }));
    const flagClass = `${isNew ? ' adm-new' : ''}${isChanged ? ' adm-changed' : ''}${ghosts.length ? ' adm-removed' : ''}`;
    const note = changeNote(seg);
    const addLabel = `Add a class on ${day}, ${slotRange(covered)}`;
    const add = () => openEditor({ day, slotIdx: start });
    let li;
    if (!first) {
      // Empty period: the whole row is the button
      li = h('li', { class: `adm-di adm-di-empty${flagClass}`, title: note, 'data-cell': `${day}|${start}` },
        time,
        editable
          ? h('button', { class: 'adm-di-body adm-di-addrow', type: 'button', 'aria-label': addLabel, onclick: add },
            ...ghostNodes(ghosts), h('span', { 'aria-hidden': 'true', text: '+ Add class' }))
          : h('span', { class: 'adm-di-body adm-di-free' }, ...ghostNodes(ghosts), h('span', { text: 'Free' })));
    } else {
      const parts = shown.flatMap(entry => (entry.members || [entry]).map(m => partNode(m, editable, home, lab)));
      li = h('li', { class: `adm-di${lab ? ' adm-di-lab' : ''}${flagClass}`, title: note, 'data-cell': `${day}|${start}`, style: bg ? `background:${bg}` : false },
        time,
        h('div', { class: 'adm-di-body' }, ...parts),
        editable ? h('button', { class: 'adm-di-plus', type: 'button', text: '+', 'aria-label': `${addLabel} (another entry)`, title: 'Add another class in this period', onclick: add }) : null);
    }
    list.append(li);
    if (start + span - 1 === lunchAfter) {
      list.append(h('li', { class: 'adm-di-lunch', text: `Lunch · ${clock(slots[lunchAfter].end)}–${clock(slots[lunchAfter + 1].start)}` }));
    }
  }
  const children = [list];
  if (!rows.length) children.push(h('p', { class: 'adm-empty', text: editable ? 'This timetable is empty. Tap a period to start, or import a CSV.' : 'Nothing scheduled.' }));
  return children;
}

function renderGrid() {
  if (!meta) return;
  syncPhoneBar();
  $('#ttGrid').replaceChildren(...(dayMode() ? buildDayList(canEdit()) : buildSheet(canEdit())));
}
phone.addEventListener('change', () => { if (loaded && rows) renderGrid(); });

function buildSheet(editable) {
  const slots = meta.slots;
  const room = currentRoom();
  const home = room?.label;
  const lunchAfter = lunchIndex(slots);
  const COLS = slots.length + 2;
  const th = (text, extra = {}) => h('th', { scope: 'col', text, ...extra });
  const cell = (children, attrs = {}) => h('td', attrs, ...children);

  // --- sheet heading (as on the printed sheet) ---
  const cls = room?.classes[0];
  const facultyClasses = [...new Set(rows.flatMap(r => r.links.map(l => l.classId)))].map(id => meta.classes.find(c => c.id === id)).filter(Boolean);
  const dept = deptTitle(mode === 'room' && room ? room.classes : facultyClasses);
  const counsellor = mode === 'room' && room ? [...new Set(room.classes.map(c => c.counsellor).filter(Boolean))].join(', ') : '';
  const branches = room ? [...new Set(room.classes.map(c => c.branchAbbr))].join(' / ') : '';
  const date = sel() === 'draft' ? meta.today : sel();
  const wef = sel() === 'draft' ? 'DRAFT (not yet published)' : `${date.slice(8, 10)}-${MONTHS[Number(date.slice(5, 7)) - 1].toUpperCase()}-${date.slice(0, 4)}`;
  const half = lunchAfter + 1;
  const titleRows = mode === 'room' && cls ? [
    h('tr', { class: 'adm-t-title' }, h('th', { colspan: COLS, text: dept })),
    h('tr', { class: 'adm-t-info' },
      h('th', { colspan: 3, class: 'l', text: `BRANCH- ${branches}` }),
      h('th', { colspan: half - 1, text: `SEMESTER - ${ROMAN[cls.semester] || cls.semester}` }),
      h('th', { colspan: 2, text: `SECTION : ${room.sections.join('/')}` }),
      h('th', { colspan: slots.length - half - 2, text: `ROOM NO. :  ${room.label}` })),
    h('tr', { class: 'adm-t-session' },
      h('th', { colspan: half + 1, text: `SESSION : ${cls.session.replace(/ (ODD|EVEN)$/, ', $1 SEMESTER')}` }),
      h('th', { colspan: slots.length - half + 1, text: `w.e.f.: ${wef}` })),
  ] : [
    h('tr', { class: 'adm-t-title' }, h('th', { colspan: COLS, text: dept })),
    h('tr', { class: 'adm-t-session' }, h('th', { colspan: COLS, text: `FACULTY : ${$('#ttTarget').selectedOptions[0]?.textContent || ''}  ·  ${sel() === 'draft' ? '(draft)' : `as on ${fmtDate(date)}`}` })),
  ];

  const head = h('tr', { class: 'adm-t-head' }, th('Day'));
  slots.forEach((s, i) => {
    head.append(th(`${clock(s.start)}–${clock(s.end)}`, { title: s.label }));
    if (i === lunchAfter) head.append(th(`${clock(s.end)}–${clock(slots[i + 1].start)}`, { class: 'adm-lunch-col' }));
  });

  const body = meta.days.map((day, dayIndex) => {
    const tr = h('tr', {}, h('th', { scope: 'row', text: day.slice(0, 3).toUpperCase(), title: day }));
    for (const seg of daySegments(day, slots, lunchAfter)) {
      const { start, span, shown, first, lab, bg, isNew, isChanged, ghosts } = seg;
      const children = [];
      shown.forEach((entry, idx) => {
        if (idx && lab) children.push(h('span', { class: 'adm-sep', 'aria-hidden': 'true', text: '/' }));
        children.push(...(entry.members || [entry]).flatMap((m, k) => [k ? h('span', { class: 'adm-sep', 'aria-hidden': 'true', text: '/' }) : null, partNode(m, editable, home, lab)]));
      });
      if (editable) {
        children.push(h('button', { class: first ? 'adm-add-mini' : 'adm-add', type: 'button', text: '+',
          'aria-label': `Add a class on ${day}, ${slots[start].label}`, title: 'Add a class here', onclick: () => openEditor({ day, slotIdx: start }) }));
      }
      children.unshift(...ghostNodes(ghosts));
      tr.append(h('td', { 'data-cell': `${day}|${start}`, colspan: span > 1 ? span : false, title: changeNote(seg), class: `${first ? 'adm-cell' : 'adm-cell adm-empty-cell'}${isNew ? ' adm-new' : ''}${isChanged ? ' adm-changed' : ''}${ghosts.length ? ' adm-removed' : ''}`, style: bg ? `background:${bg}` : false }, ...children));
      if (start + span - 1 === lunchAfter && dayIndex === 0) tr.append(h('td', { class: 'adm-lunch', rowspan: meta.days.length + 1 }, h('span', { text: 'LUNCH' })));
    }
    return tr;
  });
  // The printed sheet has a (blank) Saturday row; the schema only holds Monday to Friday.
  const sat = h('tr', { class: 'adm-sat' }, h('th', { scope: 'row', text: 'SAT' }),
    h('td', { colspan: half }), h('td', { colspan: slots.length - half }));

  const table = h('table', { class: 'adm-tt' }, h('thead', {}, ...titleRows, head), h('tbody', {}, ...body, sat), legendBody(COLS, half, slots.length, counsellor));
  const children = [table];
  if (!rows.length) children.push(h('p', { class: 'adm-empty', text: editable ? 'This timetable is empty. Click a period to start, or import a CSV.' : 'Nothing scheduled.' }));
  return children;
}

// Subject table under the grid, laid out on the same columns as the printed sheet.
function legendBody(COLS, half, nSlots, counsellor = '') {
  const stats = new Map();
  for (const r of rows) {
    const subject = subjectOf(r.subjectId);
    if (!subject?.takesAttendance) continue;
    const st = stats.get(r.subjectId) || { subject, slots: [], faculty: new Set() };
    st.slots.push({ at: `${r.day}|${r.slotId}`, batch: batchOf(r) });
    if (r.faculty) st.faculty.add(`${r.facultyName || facultyName(r.faculty)} (${r.faculty})`);
    stats.set(r.subjectId, st);
  }
  const perWeek = ({ slots }) => {
    const batches = [...new Set(slots.map(s => s.batch).filter(Boolean))];
    return Math.max(...(batches.length ? batches : [null]).map(b => new Set(slots.filter(s => !s.batch || s.batch === b).map(s => s.at)).size));
  };
  const list = [...stats.values()].sort((a, b) => meta.subjects.indexOf(a.subject) - meta.subjects.indexOf(b.subject));
  const total = list.reduce((n, st) => n + perWeek(st), 0);
  const cell = (text, attrs = {}) => h('td', { text, ...attrs });
  const span = (a, b) => ({ colspan: b - a });
  const head = h('tr', { class: 'adm-lg-head' }, h('th', { text: 'S.No.' }), h('th', { text: 'Sub Code' }), h('th', { ...span(0, half - 1), text: 'Subject Name' }), h('th', { class: 'adm-lg-n', text: 'Lectures/ Labs' }), h('th', { ...span(0, nSlots - half), text: 'Faculty Name' }));
  const trs = list.map((st, i) => {
    const isLabSubject = st.slots.some(x => x.batch) || /lab/i.test(st.subject.name);
    const style = isLabSubject ? false : `background:${colorOf(st.subject)}`;
    return h('tr', { class: 'adm-lg-row' }, cell(String(i + 1), { class: 'c' }), cell(st.subject.code, { class: 'c', style }),
      cell(`${st.subject.name} [${st.subject.abbr}]`, { ...span(0, half - 1), style }), cell(String(perWeek(st)), { class: 'c' }),
      cell([...st.faculty].join(', ') || '—', { ...span(0, nSlots - half) }));
  });
  return h('tfoot', {},
    h('tr', { class: 'adm-t-counsellor' }, h('th', { colspan: COLS, class: 'l', text: `Class Counsellor:${counsellor ? ' ' + counsellor : ''}` })),
    head, ...trs,
    h('tr', { class: 'adm-lg-total' }, cell('', {}), cell('', {}), cell('', span(0, half - 1)), cell(String(total), { class: 'c' }), cell('', span(0, nSlots - half))));
}
const facultyName = abbr => meta.faculties.find(f => f.abbr === abbr)?.name || abbr;

document.querySelectorAll('#ttModeSeg button').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; syncMode(); fillTargets(); syncSpace(); loadGrid(); }));
const printDialog = $('#printDialog');
const printBoxes = () => [...document.querySelectorAll('#printRooms input')];
$('#ttPrintBtn').addEventListener('click', () => {
  const current = mode === 'room' ? $('#ttTarget').value : '';
  $('#printRooms').replaceChildren(...rooms.map(r => h('label', { class: 'adm-chip' },
    h('input', { type: 'checkbox', value: r.id, checked: String(r.id) === current }), roomTitle(r))));
  $('#printAll').checked = false;
  $('#printError').hidden = true;
  printDialog.showModal();
});
$('#printAll').addEventListener('change', e => printBoxes().forEach(b => (b.checked = e.target.checked)));
$('#printRooms').addEventListener('change', () => { $('#printAll').checked = printBoxes().every(b => b.checked); });
$('#printCancelBtn').addEventListener('click', () => printDialog.close());
$('#printForm').addEventListener('submit', async event => {
  event.preventDefault();
  const picked = rooms.filter(r => printBoxes().some(b => b.checked && b.value === String(r.id)));
  if (!picked.length) { $('#printError').textContent = 'Choose at least one classroom.'; $('#printError').hidden = false; return; }
  const button = $('#printGoBtn');
  setBusy(button, true);
  try {
    await printSheets(picked);
    printDialog.close();
  } catch (error) {
    $('#printError').textContent = errorText(error);
    $('#printError').hidden = false;
  } finally {
    setBusy(button, false);
  }
});

// One page per classroom, rendered off-screen and printed together.
async function printSheets(selected) {
  const saved = { mode, rows };
  const sheets = [];
  try {
    mode = 'room';
    for (const room of selected) {
      ({ rows } = await api(`${TT}/grid?roomId=${room.id}&${viewParam()}`));
      printRoom = room;
      sheets.push(h('section', { class: 'adm-print-sheet' }, ...buildSheet(false)));
    }
  } finally {
    printRoom = null;
    ({ mode, rows } = saved);
  }
  const area = document.getElementById('ttPrintArea') || document.body.appendChild(h('div', { id: 'ttPrintArea' }));
  area.replaceChildren(...sheets);
  document.body.classList.add('tt-printing');
  const done = () => { document.body.classList.remove('tt-printing'); area.replaceChildren(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
$('#ttHelpBtn').addEventListener('click', () => { const box = $('#ttHelp'); box.hidden = !box.hidden; $('#ttHelpBtn').setAttribute('aria-expanded', String(!box.hidden)); });
$('#ttViewBtn').addEventListener('click', () => { phoneView = phoneView === 'day' ? 'week' : 'day'; syncPhoneBar(); renderGrid(); $('#ttViewBtn').focus(); });
// Phones: version, view-by and print sit behind one "Options" button so the timetable is on the first screen
$('#ttOptBtn').addEventListener('click', () => {
  const form = $('#ttFilters');
  const open = !form.classList.contains('adm-open');
  form.classList.toggle('adm-open', open);
  $('#ttOptBtn').setAttribute('aria-expanded', String(open));
});
$('#ttTarget').addEventListener('change', loadGrid);
$('#ttDate').addEventListener('change', loadGrid);
document.querySelectorAll('#ttSpaceSeg button').forEach(b => b.addEventListener('click', () => { setSpace(b.dataset.space); b.focus(); }));
$('#ttUndoBtn').addEventListener('click', () => stepDraft('undo'));
$('#ttRedoBtn').addEventListener('click', () => stepDraft('redo'));
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || $('#view-timetable').hidden || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) { event.preventDefault(); if (!$('#ttUndoBtn').disabled) stepDraft('undo'); }
  else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); if (!$('#ttRedoBtn').disabled) stepDraft('redo'); }
});
$('#ttImportBtn').addEventListener('click', () => openImport('timetable', () => afterEdit()));

// ---------------- cell editor ----------------
const dialog = $('#cellDialog');
let ctx = null;
let checkTimer = null;
let checkToken = 0;
let conflicts = [];

function buildLinks() {
  const batch = $('#cellBatch').value.trim() || null;
  return [...document.querySelectorAll('#cellClasses input:checked')].map(box => ({ classId: Number(box.value), batch }));
}

const lunchAt = () => meta.slots.findIndex((s, i) => i < meta.slots.length - 1 && toMin(meta.slots[i + 1].start) - toMin(s.end) >= 20);

// Where the entry would sit after "Move this class": { day, slotIds }, { unchanged: true } or { error }
function moveTarget() {
  const n = ctx.entry.rows.length;
  const day = $('#cellMoveDay').value || ctx.day;
  const start = Number($('#cellMoveSlot').value);
  if (day === ctx.day && start === ctx.entry.slotIdx) return { unchanged: true, day, slotIds: ctx.entry.rows.map(r => r.slotId) };
  const end = start + n - 1;
  if (end >= meta.slots.length) return { error: `${n} periods do not fit from that period. Choose an earlier start.` };
  const lunch = lunchAt();
  if (lunch >= 0 && start <= lunch && end > lunch) return { error: 'A class cannot run across the lunch break. Choose another start.' };
  return { day, slotIds: meta.slots.slice(start, end + 1).map(s => s.id) };
}
const formDay = () => (ctx.entry ? moveTarget().day || ctx.day : ctx.day);
function slotIdsForForm() {
  if (ctx.entry) { const t = moveTarget(); return t.slotIds || ctx.entry.rows.map(r => r.slotId); }
  const span = Number($('#cellSpan').value) || 1;
  return meta.slots.slice(ctx.slotIdx, ctx.slotIdx + span).map(s => s.id);
}
function drawMoveHint() {
  const t = moveTarget();
  $('#cellMoveHint').textContent = t.error || (t.unchanged ? '' : `Will move to ${t.day}, ${slotRange(t.slotIds.map(id => meta.slots.find(s => s.id === id)))}.`);
}

function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 250);
}

async function runCheck() {
  const token = ++checkToken;
  const rowsInEntry = ctx.entry?.rows || [];
  try {
    const { conflicts: found } = await api('/api/admin/timetable/check', { method: 'POST', body: {
      day: formDay(), slotIds: slotIdsForForm(), facultyId: $('#cellFaculty').value, roomId: $('#cellRoom').value,
      links: buildLinks(), excludeIds: rowsInEntry.map(r => r.id) } });
    if (token !== checkToken) return;
    conflicts = found;
    const moved = ctx.entry ? moveTarget() : null;
    if (moved?.error) found.push({ message: moved.error });
    const box = $('#cellConflicts');
    box.className = `adm-conflicts ${found.length ? 'bad' : 'ok'}`;
    box.replaceChildren(...(found.length
      ? [h('strong', { text: `${found.length} clash${found.length === 1 ? '' : 'es'} found` }), h('ul', {}, ...found.map(c => h('li', { text: c.message })))]
      : [h('span', { text: '✓ No clashes' })]));
    $('#cellSaveBtn').disabled = found.length > 0;
  } catch {
    if (token === checkToken) $('#cellConflicts').replaceChildren();
  }
}

function openEditor({ entry, day, slotIdx }) {
  const first = entry?.rows[0];
  ctx = { entry, day: entry ? first.day : day, slotIdx: entry ? entry.slotIdx : slotIdx };
  pendingCell = { day: ctx.day, start: ctx.slotIdx };
  const slots = meta.slots;
  const sheetRoom = currentRoom();
  const covered = entry ? entry.rows.map(r => slots.find(s => s.id === r.slotId)) : [slots[slotIdx]];
  $('#cellTitle').textContent = entry ? `Edit ${first.subjectName}` : 'Add class';
  $('#cellWhen').textContent = `${roomTitle(sheetRoom)} · ${ctx.day} · ${slotRange(covered)}${entry && covered.length > 1 ? ` (${covered.length} periods)` : ''}`;

  fillSelect($('#cellSubject'), meta.subjects.map(s => ({ value: s.id, label: `${s.abbr} – ${s.name}` })), 'Choose subject…');
  fillSelect($('#cellFaculty'), meta.faculties.map(f => ({ value: f.id, label: `${f.abbr} – ${f.name}` })), 'None');
  fillSelect($('#cellRoom'), meta.rooms.map(r => ({ value: r.id, label: r.label })), 'None');
  $('#cellSubject').value = first?.subjectId ?? '';
  $('#cellFaculty').value = first?.facultyId ?? '';
  $('#cellRoom').value = first?.roomId ?? sheetRoom.id ?? '';
  $('#cellBatch').value = first?.links.find(l => l.batch)?.batch ?? '';
  Object.keys(COMBO_OPTS).forEach(sel => $(sel).syncCombo());

  // How many consecutive periods can this start at (a lab = 2) without crossing lunch
  const lunchAfter = slots.findIndex((s, i) => i < slots.length - 1 && toMin(slots[i + 1].start) - toMin(s.end) >= 20);
  const room = Math.min(4, (lunchAfter >= slotIdx ? lunchAfter : slots.length - 1) - slotIdx + 1);
  fillSelect($('#cellSpan'), Array.from({ length: room }, (_, i) => ({ value: i + 1, label: i ? `${i + 1} periods` : '1 period' })));
  $('#cellSpanField').hidden = Boolean(entry);

  $('#cellFromField').hidden = true;
  // Moving an existing class: pick another day / starting period (same number of periods)
  $('#cellMoveField').hidden = !entry;
  if (entry) {
    fillSelect($('#cellMoveDay'), meta.days.map(d => ({ value: d, label: d })));
    $('#cellMoveDay').value = ctx.day;
    fillSelect($('#cellMoveSlot'), slots.map((s, i) => ({ value: i, label: `${clock(s.start)}–${clock(s.end)} (${s.label})` })));
    $('#cellMoveSlot').value = String(entry.slotIdx);
    $('#cellMoveHint').textContent = '';
  }

  const sessions = new Set(sheetRoom.classes.map(c => c.session));
  const semesters = new Set(sheetRoom.classes.map(c => c.semester));
  const linked = new Set(entry ? first.links.map(l => l.classId) : sheetRoom.classes.map(c => c.id));
  // Combined lectures are almost always within one semester; keep any class already linked.
  const pool = meta.classes.filter(c => (sessions.has(c.session) && semesters.has(c.semester)) || linked.has(c.id));
  $('#cellClassesField').hidden = false;
  $('#cellClasses').replaceChildren(...pool.map(c => h('label', { class: 'adm-chip' }, h('input', { type: 'checkbox', value: c.id, checked: linked.has(c.id) || false }), c.short)));

  $('#cellDeleteBtn').hidden = !entry;
  $('#cellSaveBtn').disabled = false;
  $('#cellConflicts').replaceChildren();
  $('#cellConflicts').className = 'adm-conflicts';
  setBox('cellError', '');
  conflicts = [];
  dialog.showModal();
  $('#cellSubject').comboInput.focus();
  // Check straight away (also for a new cell), so the dialog never opens without a result
  $('#cellConflicts').replaceChildren(h('span', { text: 'Checking for clashes…' }));
  runCheck();
}

// Real comboboxes (core.js) in place of the native <datalist>: the list opens on focus and narrows as you type
const COMBO_OPTS = {
  '#cellSubject': { placeholder: 'Search subject…' },
  '#cellFaculty': { placeholder: 'None – search faculty…', allowNone: true },
  '#cellRoom': { placeholder: 'None – search room…', allowNone: true },
};
Object.entries(COMBO_OPTS).forEach(([sel, opts]) => createCombobox($(sel), opts));

['#cellFaculty', '#cellRoom', '#cellBatch', '#cellSpan', '#cellFrom', '#cellClasses', '#cellMoveDay', '#cellMoveSlot'].forEach(sel =>
  $(sel).addEventListener('input', () => ctx && scheduleCheck()));
$('#cellClasses').addEventListener('change', () => ctx && scheduleCheck());
['#cellMoveDay', '#cellMoveSlot'].forEach(sel => $(sel).addEventListener('change', () => ctx && drawMoveHint()));
$('#cellCancelBtn').addEventListener('click', () => dialog.close());

$('#cellForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('#cellSubject').value) return setBox('cellError', 'Choose a subject.');
  if (!buildLinks().length) return setBox('cellError', 'Choose at least one class.');
  const button = $('#cellSaveBtn');
  const body = { subjectId: $('#cellSubject').value, facultyId: $('#cellFaculty').value, roomId: $('#cellRoom').value, links: buildLinks() };
  const move = ctx.entry ? moveTarget() : null;
  if (move?.error) return setBox('cellError', move.error);
  setBusy(button, true);
  setBox('cellError', '');
  try {
    if (ctx.entry) await api('/api/admin/timetable/entry', { method: 'PUT', body: { ...body, ids: ctx.entry.rows.map(r => r.id), ...(move.unchanged ? {} : { moveTo: { day: move.day, slotIds: move.slotIds } }) } });
    else await api('/api/admin/timetable/entry', { method: 'POST', body: { ...body, day: ctx.day, slotIds: slotIdsForForm() } });
    dialog.close();
    if (ctx.entry && !move.unchanged) pendingCell = { day: move.day, start: meta.slots.findIndex(s => s.id === move.slotIds[0]) };
    showToast(ctx.entry ? (move.unchanged ? 'Saved to the draft.' : 'Moved and saved to the draft.') : 'Added to the draft.', 'success');
    afterEdit();
  } catch (error) {
    if (error.code === 'conflict' && error.body?.conflicts) {
      conflicts = error.body.conflicts;
      $('#cellConflicts').className = 'adm-conflicts bad';
      $('#cellConflicts').replaceChildren(h('strong', { text: 'Clash found' }), h('ul', {}, ...conflicts.map(c => h('li', { text: c.message }))));
    } else setBox('cellError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});

$('#cellDeleteBtn').addEventListener('click', () => {
  const entry = ctx.entry;
  askDelete({
    title: `Remove ${entry.rows[0].subjectName}?`,
    text: 'It is removed from the draft only. Nothing changes in the live timetable until you publish, and you can undo this.',
    run: async () => {
      try {
        await api(`${TT}/entry?ids=${entry.rows.map(r => r.id).join(',')}`, { method: 'DELETE' });
      } catch (error) {
        throw Object.assign(error, { message: errorText(error) });
      }
      dialog.close();
      showToast('Removed from the draft.', 'success');
      afterEdit();
    },
  });
});

// ---------------- publish ----------------
const publishDialog = $('#publishDialog');
async function openPublish() {
  setBox('publishError', '');
  $('#publishError').hidden = true;
  try {
    const info = await api(`${TT}/draft/changes`);
    const earliest = info.latest && info.latest > info.today ? info.latest : info.today;
    $('#publishDate').min = info.latest || '';
    $('#publishDate').value = info.latest && info.latest > info.today ? info.latest : info.today;
    $('#publishDateText').textContent = fmtDate($('#publishDate').value);
    $('#publishIntro').textContent = info.changes.length
      ? `${info.changes.length} change${info.changes.length === 1 ? '' : 's'} will become a new version. Periods that already have attendance are kept as they were before the date below.`
      : 'There are no changes to publish.';
    $('#publishChanges').replaceChildren(...info.changes.map(c => h('li', { class: `adm-change-${c.type}` }, h('strong', { text: c.type === 'added' ? 'Added' : c.type === 'removed' ? 'Removed' : 'Changed' }), ` ${c.text}`)));
    $('#publishGoBtn').disabled = !info.changes.length;
    void earliest;
    publishDialog.showModal();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}
$('#publishDate').addEventListener('input', () => { $('#publishDateText').textContent = fmtDate($('#publishDate').value); });
$('#publishCancelBtn').addEventListener('click', () => publishDialog.close());
$('#publishForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#publishGoBtn');
  setBusy(button, true);
  setBox('publishError', '');
  try {
    const result = await api(`${TT}/draft/publish`, { method: 'POST', body: { effectiveFrom: $('#publishDate').value } });
    publishDialog.close();
    space = 'published'; // the new version is live now: show it as published
    await refreshMeta({ prefer: result.effectiveFrom });
    await loadGrid();
    showToast(`Published. New version from ${fmtDate(result.effectiveFrom)}.`, 'success');
  } catch (error) {
    setBox('publishError', errorText(error));
    $('#publishError').hidden = false;
  } finally {
    setBusy(button, false);
  }
});

// ---------------- copy a day ----------------
const copyDialog = $('#copyDayDialog');
function drawCopyTargets() {
  const from = $('#copyFrom').value;
  $('#copyTo').replaceChildren(...meta.days.filter(d => d !== from).map(d => h('label', { class: 'adm-chip' }, h('input', { type: 'checkbox', value: d }), d)));
}
$('#ttCopyDayBtn').addEventListener('click', () => {
  if (!canEdit()) return;
  const counts = Object.fromEntries(meta.days.map(d => [d, rows.filter(r => r.day === d).length]));
  $('#copyDayRoom').textContent = `${roomTitle(currentRoom())}. Copies every period of one day onto the days you choose.`;
  fillSelect($('#copyFrom'), meta.days.map(d => ({ value: d, label: `${d} (${counts[d]} period${counts[d] === 1 ? '' : 's'})` })));
  const filled = meta.days.find(d => counts[d]);
  if (filled) $('#copyFrom').value = filled;
  $('#copyReplace').checked = false;
  drawCopyTargets();
  setBox('copyError', '');
  copyDialog.showModal();
  $('#copyFrom').focus();
});
$('#copyFrom').addEventListener('change', drawCopyTargets);
$('#copyCancelBtn').addEventListener('click', () => copyDialog.close());
$('#copyDayForm').addEventListener('submit', async event => {
  event.preventDefault();
  const toDays = [...document.querySelectorAll('#copyTo input:checked')].map(b => b.value);
  if (!toDays.length) return setBox('copyError', 'Choose at least one day to copy to.');
  const button = $('#copyGoBtn');
  setBusy(button, true);
  setBox('copyError', '');
  try {
    const result = await api(`${TT}/copy-day`, { method: 'POST', body: { roomId: currentRoom().id, fromDay: $('#copyFrom').value, toDays, replace: $('#copyReplace').checked } });
    pendingCell = null;
    copyDialog.close();
    showToast(`Copied ${result.copied} period${result.copied === 1 ? '' : 's'} to the draft.`, 'success');
    await afterEdit();
    announce(`Copied ${result.copied} periods to ${toDays.join(', ')}.`);
  } catch (error) {
    const found = error.body?.conflicts;
    setBox('copyError', found?.length ? `${found.slice(0, 3).map(c => c.message).join(' ')}${found.length > 3 ? ` (and ${found.length - 3} more clashes)` : ''} Nothing was copied.` : errorText(error));
  } finally {
    setBusy(button, false);
  }
});
