// master.js - term setup + one table per kind of record (students, faculty, subjects, classes ...).
import { $, $$, h, api, createDataTable, askConfirm, rowActions, setBusy, setBox, setFieldMsg, errorText, fillSelect, showToast, maskSecrets, copyText, announce, downloadCsv } from './core.js';
import { openImport } from './import.js';

const goto = view => document.dispatchEvent(new CustomEvent('admin:goto', { detail: view }));
let meta = null;
let active = 'students';
let rows = [];
const cache = {};
const SOFT = ['students', 'faculties']; // never deleted: their history is kept, so they are deactivated
const softNoun = () => (active === 'faculties' ? 'faculty member' : 'student');
const softNouns = () => (active === 'faculties' ? 'faculty' : 'students');
let table = null;

async function loadMeta(force = false) {
  if (meta && !force) return meta;
  meta = await api('/api/admin/master/meta');
  return meta;
}

// ---------------- Term setup card ----------------
const defaultSession = () => {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 5 ? `${y}-${y + 1} ODD` : `${y - 1}-${y} EVEN`;
};

async function loadTerm() {
  await loadMeta();
  const select = $('#termSession');
  const sessions = meta.sessions.length ? meta.sessions : [defaultSession()];
  const previous = select.value;
  fillSelect(select, sessions.map(s => ({ value: s, label: s })));
  if (sessions.includes(previous)) select.value = previous;
  const s = await api(`/api/admin/master/term-status?session=${encodeURIComponent(select.value)}`);
  // Each row: tick when fine, "!" when something needs doing. `note` is extra information that never blocks the tick.
  const steps = [];
  const step = ({ ok, label, detail, note, action, onclick }) => {
    steps.push(ok);
    return h('li', { class: ok ? 'done' : 'todo' },
      h('span', { class: 'adm-check', 'aria-hidden': 'true', text: ok ? '✓' : '!' }),
      h('span', { class: 'adm-check-text' }, h('strong', { text: label }), h('span', { text: detail }), ...(note ? [h('span', { class: 'adm-check-note', text: note })] : [])),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: action, onclick }));
  };
  const n = (count, noun, plural = `${noun}s`) => `${count} ${count === 1 ? noun : plural}`;
  $('#termSteps').replaceChildren(
    step(s.classes > 0
      ? { ok: true, label: 'Classes', detail: `${n(s.classes, 'class', 'classes')} in ${n(s.classrooms, 'classroom')}`, action: 'View', onclick: () => switchTab('classes') }
      : { ok: false, label: 'Classes', detail: `No classes in ${s.session} yet`, action: 'Set up', onclick: openWizard }),
    step({ ok: s.classes > 0 && s.classesWithoutRoom === 0, label: 'Home rooms', detail: !s.classes ? 'Needs classes first' : s.classesWithoutRoom ? `${n(s.classesWithoutRoom, 'class', 'classes')} without a home room` : 'Every class has a home room', action: 'Classes', onclick: () => switchTab('classes') }),
    step({ ok: s.students > 0 && s.unassignedStudents === 0, label: 'Students', detail: `${n(s.students, 'student')} placed in classes`, note: s.unassignedStudents ? `${n(s.unassignedStudents, 'student')} for this term not in any class` : '', action: s.unassignedStudents ? 'Assign' : 'Manage', onclick: () => (s.unassignedStudents ? openWizard() : switchTab('students')) }),
    step({ ok: s.faculty > 0, label: 'Faculty', detail: `${s.faculty} active`, note: s.facultyIdle ? `${s.facultyIdle} with no periods yet` : '', action: 'Manage', onclick: () => switchTab('faculties') }),
    step({ ok: s.subjects > 0, label: 'Subjects', detail: `${s.subjects} on file`, note: s.subjectsUnscheduled ? `${s.subjectsUnscheduled} not in any timetable` : '', action: 'Manage', onclick: () => switchTab('subjects') }),
    step({ ok: s.classes > 0 && s.classesWithTimetable >= s.classes, label: 'Timetable', detail: `${s.classesWithTimetable} of ${n(s.classes, 'class', 'classes')} scheduled`, action: 'Open', onclick: () => goto('timetable') }),
    ...(s.batchNeeded > 0 ? [step({ ok: s.batchAssigned >= s.batchNeeded, label: 'Lab batches', detail: `${s.batchAssigned} of ${s.batchNeeded} students in G1 / G2`, note: 'Lab attendance needs a batch', action: 'Split…', onclick: () => openSplit(select.value) })] : []),
    ...(s.students > 0 ? [step({ ok: s.withoutFace === 0, label: 'Face photos', detail: s.withoutFace ? `${n(s.withoutFace, 'student')} without photos` : 'Everyone has uploaded photos', action: 'Open', onclick: () => goto('enrollment') })] : []),
  );
  // One slim strip: the checklist opens by itself only while something is still to do.
  const done = steps.filter(Boolean).length;
  const allDone = done === steps.length;
  const sessionKey = select.value;
  const open = allDone ? termManual.has(sessionKey) : !termManual.has(`closed:${sessionKey}`);
  const state = $('#termSummaryText');
  state.textContent = allDone ? '✓ Setup complete' : `${steps.length - done} thing${steps.length - done === 1 ? '' : 's'} to do`;
  state.classList.toggle('is-done', allDone);
  $('#termSteps').hidden = !open;
  $('#termToggleBtn').textContent = open ? 'Hide checklist' : 'Checklist';
  $('#termToggleBtn').setAttribute('aria-expanded', String(open));
}
const termManual = new Set();
$('#termToggleBtn').addEventListener('click', () => {
  const key = $('#termSession').value;
  const open = $('#termToggleBtn').getAttribute('aria-expanded') !== 'true';
  // Remember the choice for this session: "opened" matters when complete, "closed" when incomplete
  termManual.delete(key); termManual.delete(`closed:${key}`);
  const complete = $('#termSummaryText').classList.contains('is-done');
  if (complete && open) termManual.add(key);
  if (!complete && !open) termManual.add(`closed:${key}`);
  $('#termSteps').hidden = !open;
  $('#termToggleBtn').textContent = open ? 'Hide checklist' : 'Checklist';
  $('#termToggleBtn').setAttribute('aria-expanded', String(open));
});

// ---------------- Lab batches: split in the middle, or from a chosen student ----------------
const splitDialog = $('#splitDialog');
let splitSession = '';
let splitStudents = []; // active students of the chosen class, by roll number
const byRoll = (a, b) => String(a.roll_number ?? '').localeCompare(String(b.roll_number ?? ''), undefined, { numeric: true }) || a.name.localeCompare(b.name);

async function openSplit(session) {
  splitSession = session;
  $('#splitMode').value = 'mid';
  $('#splitCustom').hidden = true;
  setBox('splitError', '');
  splitDialog.showModal();
  $('#splitMode').focus();
}
function drawSplitPreview() {
  const n = splitStudents.length;
  const at = splitStudents.findIndex(st => String(st.id) === $('#splitStudent').value);
  $('#splitPreview').textContent = n && at >= 0 ? `G1: ${at} student${at === 1 ? '' : 's'}. G2: ${n - at} student${n - at === 1 ? '' : 's'}.` : '';
}
async function loadSplitStudents() {
  const classId = Number($('#splitClass').value);
  if (!classId) { splitStudents = []; fillSelect($('#splitStudent'), [], 'No students'); return drawSplitPreview(); }
  const { rows: all } = await api('/api/admin/master/entity/students');
  splitStudents = all.filter(r => r.active && r.class_id === classId).sort(byRoll);
  fillSelect($('#splitStudent'), splitStudents.map(st => ({ value: st.id, label: `${st.roll_number || '–'} · ${st.name}` })));
  if (splitStudents.length) $('#splitStudent').value = String(splitStudents[Math.ceil(splitStudents.length / 2)]?.id ?? splitStudents.at(-1).id); // the default: the middle
  drawSplitPreview();
}
$('#splitMode').addEventListener('change', async event => {
  const custom = event.target.value === 'custom';
  $('#splitCustom').hidden = !custom;
  if (!custom) return;
  setBox('splitError', '');
  try {
    const { rows: classes } = await api('/api/admin/master/entity/classes');
    const inSession = classes.filter(c => c.academic_session === splitSession);
    fillSelect($('#splitClass'), inSession.map(c => ({ value: c.id, label: `${c.branch} Sem ${c.semester} ${c.section} (${c.students} students)` })), inSession.length ? null : 'No classes');
    await loadSplitStudents();
  } catch (error) { setBox('splitError', errorText(error)); }
});
$('#splitClass').addEventListener('change', () => loadSplitStudents().catch(error => setBox('splitError', errorText(error))));
$('#splitStudent').addEventListener('change', drawSplitPreview);
$('#splitCancelBtn').addEventListener('click', () => splitDialog.close());
$('#splitForm').addEventListener('submit', async event => {
  event.preventDefault();
  const custom = $('#splitMode').value === 'custom';
  if (custom && !$('#splitStudent').value) return setBox('splitError', 'Choose the class and the first student in G2.');
  const button = $('#splitGoBtn');
  setBusy(button, true);
  setBox('splitError', '');
  try {
    const r = await api('/api/admin/master/assign-batches', { method: 'POST', body: { session: splitSession, ...(custom ? { classId: Number($('#splitClass').value), g2StartStudentId: Number($('#splitStudent').value) } : {}) } });
    splitDialog.close();
    showToast(`Assigned batches to ${r.updated} students.`, 'success');
    refresh();
  } catch (error) {
    setBox('splitError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});
$('#termSession').addEventListener('change', () => loadTerm().catch(() => {}));

// ---------------- Tabs + table ----------------
// Camera addresses can contain a login, so the table shows them masked until "Show" is pressed
function renderCameraUrl(row, td) {
  const full = row.camera_url || '';
  const masked = maskSecrets(full);
  const text = h('span', { class: 'adm-url', text: masked });
  const wrap = h('span', { class: 'adm-url-cell' }, text);
  if (masked !== full) {
    let timer = null;
    const button = h('button', { class: 'link-btn', type: 'button', text: 'Show', 'aria-pressed': 'false', 'aria-label': `Show the full camera address of room ${row.block}-${row.number}` });
    const set = show => {
      clearTimeout(timer);
      text.textContent = show ? full : masked;
      button.textContent = show ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} the full camera address of room ${row.block}-${row.number}`);
      if (show) timer = setTimeout(() => set(false), 15000); // hides itself again
    };
    button.addEventListener('click', () => set(button.getAttribute('aria-pressed') !== 'true'));
    wrap.append(button);
  }
  td.append(wrap);
}

function buildTabs() {
  $('#masterTabs').replaceChildren(...Object.entries(meta.entities).map(([key, e]) =>
    h('button', { class: 'adm-tab', type: 'button', role: 'tab', id: `masterTab-${key}`, 'aria-selected': String(key === active), 'aria-controls': 'masterTable', tabindex: key === active ? '0' : '-1', 'data-tab': key, text: e.label, onclick: () => switchTab(key) })));
}

// Arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern); only the selected tab is in the Tab order
$('#masterTabs').addEventListener('keydown', event => {
  const tabs = $$('#masterTabs .adm-tab');
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  const next = { ArrowRight: (at + 1) % tabs.length, ArrowLeft: (at - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  tabs[next].focus();
  switchTab(tabs[next].dataset.tab);
});

// ---- Classes tab: one row per CLASSROOM ----
// A classroom is one home room with its section and the class(es) taught in it (DS and AIML in 5D are one row).
// Classes with no home room each stand alone. The rows are built from the plain class list.
function groupClassrooms(list) {
  const groups = new Map();
  for (const c of list) {
    const key = c.room_id ? `${c.academic_session}|${c.room_id}|${c.section}` : `class${c.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups].map(([key, classes]) => {
    const first = classes[0];
    const names = [...new Set(classes.map(c => `${c.semester}${c.section}`))];
    return {
      id: key,
      classes,
      classroom: `${names.join(' + ')} · ${first.room || 'No home room'}`,
      classesText: classes.map(c => c.branch).join(', '),
      academic_session: first.academic_session,
      counsellor: [...new Set(classes.map(c => c.counsellor).filter(Boolean))].join(', '),
      students: classes.reduce((n, c) => n + c.students, 0),
    };
  });
}

function makeTable() {
  const entity = meta.entities[active];
  const columns = entity.columns.map(([key, label]) => ({
    key, label, sortable: true, get: r => r[key],
    ...(key === 'name' && SOFT.includes(active) ? { render: (r, td) => td.append(r.name, ...(r.active ? [] : [' ', h('span', { class: 'badge', text: 'Inactive' })])) } : {}),
    ...(['periods', 'semester', 'students'].includes(key) ? { num: true } : {}),
    ...(key === 'camera_url' ? { clip: true, get: r => maskSecrets(r.camera_url), render: renderCameraUrl } : {}),
    ...(active === 'classes' && key === 'classroom' ? { render: (r, td) => td.append(h('strong', { text: r.classroom })) } : {}),
  }));
  const students = active === 'students';
  columns.push({ key: 'actions', label: 'Actions', render: (r, td) => {
    if (active === 'classes') { // each class of the classroom keeps its own Edit and Delete
      for (const c of r.classes) {
        const label = `${c.branch} Sem ${c.semester}`;
        td.append(h('div', { class: 'adm-class-line' }, r.classes.length > 1 ? h('span', { class: 'adm-class-name', text: label }) : null, rowActions('class', c, label, openEditor, askRemove)));
      }
      return;
    }
    const name = r.name || r.label || r.abbr || r.code || `#${r.id}`;
    // Students are never deleted (their attendance history is kept), so the button says what it does
    const soft = SOFT.includes(active);
    const opts = !soft ? {} : r.active ? { removeLabel: 'Deactivate' } : { removeLabel: 'Reactivate', removeKind: 'secondary' };
    td.append(rowActions(entity.singular, r, name, openEditor, soft && !r.active ? reactivate : askRemove, opts));
    // New password for one person: the handover dialog shows it once
    if (soft) {
      const actions = td.querySelector('.adm-actions');
      actions.insertBefore(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Reset password', 'aria-label': `Reset password for ${name}`, onclick: () => askReset(r) }), actions.children[1]);
    }
  } });
  table = createDataTable({ mount: $('#masterTable'), noun: entity.singular, pageSize: 12, columns, selectable: students, onSelect: updateBulk, emptyHint: `Select "Add" to create the first ${entity.singular}.`, onRetry: () => loadRows() });
}

async function loadRows() {
  if (!cache[active]) table.setLoading();
  try {
    ({ rows } = await api(`/api/admin/master/entity/${active}`));
    cache[active] = true;
    table.setRows(active === 'classes' ? groupClassrooms(rows) : rows);
    applyFilters();
  } catch {
    table.setError();
  }
}

export async function switchTab(key) {
  active = key;
  await loadMeta();
  $$('#masterTabs .adm-tab').forEach(t => {
    t.setAttribute('aria-selected', String(t.dataset.tab === key));
    t.tabIndex = t.dataset.tab === key ? 0 : -1;
  });
  $('#masterTable').setAttribute('aria-labelledby', `masterTab-${key}`);
  const entity = meta.entities[key];
  $('#masterAddBtn').textContent = `Add ${entity.singular}`;
  $('#masterImportBtn').hidden = !['students', 'faculties'].includes(key);
  $('#masterSearch').value = '';
  makeTable();
  setupFilters();
  loadRows();
}

export async function loadMaster() {
  try {
    await loadMeta(true);
  } catch {
    $('#masterTable').replaceChildren(h('div', { class: 'adm-state', role: 'alert' }, h('strong', { text: 'Could not load setup data' }), h('button', { class: 'btn btn-secondary', type: 'button', text: 'Try again', onclick: loadMaster })));
    return;
  }
  buildTabs();
  loadTerm().catch(() => {});
  switchTab(active);
}

$('#masterSearch').addEventListener('input', e => table?.setQuery(e.target.value));
$('#masterAddBtn').addEventListener('click', () => openEditor(null));
$('#masterImportBtn').addEventListener('click', () => openImport(active === 'students' ? 'students' : 'faculty', refresh));

function refresh() {
  cache[active] = true;
  loadRows();
  loadTerm().catch(() => {});
}

// ---------------- Filters and bulk actions (students) ----------------
const classOptions = () => meta.entities.students.fields.find(f => f.name === 'class_id')?.options || [];
function setupFilters() {
  const students = active === 'students';
  $('#masterFilters').hidden = !SOFT.includes(active);
  $('#masterClassField').hidden = !students;
  $('#masterBulk').hidden = true;
  if (!SOFT.includes(active)) return;
  if (students) {
    fillSelect($('#masterClassFilter'), [{ value: '', label: 'All classes' }, { value: 'none', label: 'No class' }, ...classOptions()]);
    fillSelect($('#bulkClass'), classOptions(), 'Choose class…');
  }
  $('#masterShowInactive').checked = false;
  $('#masterOnlyInactive').checked = false;
  $('#masterOnlyInactiveWrap').hidden = true;
}
function applyFilters() {
  if (!SOFT.includes(active) || !table) return;
  const cls = active === 'students' ? $('#masterClassFilter').value : '';
  const show = $('#masterShowInactive').checked;
  const only = $('#masterOnlyInactive').checked;
  const inactive = rows.filter(r => !r.active).length;
  $('#masterShowInactive').nextSibling.textContent = ` Show inactive ${softNouns()} (${inactive})`;
  table.setFilter(r => (show ? !only || !r.active : Boolean(r.active)) && (!cls || (cls === 'none' ? !r.class_id : String(r.class_id) === cls)));
}
const filtersChanged = () => { table?.clearSelection(); applyFilters(); };
$('#masterClassFilter').addEventListener('change', filtersChanged);
$('#masterShowInactive').addEventListener('change', event => {
  $('#masterOnlyInactiveWrap').hidden = !event.target.checked;
  if (!event.target.checked) $('#masterOnlyInactive').checked = false;
  filtersChanged();
});
$('#masterOnlyInactive').addEventListener('change', filtersChanged);

function updateBulk(ids) {
  $('#masterBulk').hidden = !ids.length;
  $('#masterBulkCount').textContent = `${ids.length} selected`;
  if (ids.length) announce(`${ids.length} student${ids.length === 1 ? '' : 's'} selected. Bulk actions are available above the table.`);
}
async function bulk(action, extra = {}) {
  const ids = table.selected;
  const r = await api('/api/admin/master/students-bulk', { method: 'POST', body: { ids, action, ...extra } });
  table.clearSelection();
  refresh();
  return r.updated;
}
$('#bulkPasswordsBtn').addEventListener('click', () => {
  const ids = [...table.selected];
  askConfirm({
    title: `Make new passwords for ${ids.length} student${ids.length === 1 ? '' : 's'}?`,
    text: 'Each one gets a new random password and the old one stops working at once. You will get a CSV file with the new passwords to hand out. It is made now and is not kept anywhere else, so keep it safe.',
    confirmLabel: 'Generate passwords', cancelLabel: 'Keep them', danger: false,
    failText: 'Could not generate the passwords. Try again.',
    run: async () => {
      const r = await api('/api/admin/master/passwords', { method: 'POST', body: { entity: 'students', ids } });
      downloadCsv(`student-passwords-${meta.today}.csv`, ['Name', 'Roll number', 'Username', 'Password'], r.passwords.map(p => [p.name, p.rollNumber, p.username, p.password]));
      table.clearSelection();
      showToast(`${r.passwords.length} new passwords saved to a CSV file.`, 'success');
    },
  });
});
$('#bulkClearBtn').addEventListener('click', () => { table.clearSelection(); $('#masterSearch').focus(); });
$('#bulkReactivateBtn').addEventListener('click', async () => {
  try { showToast(`${await bulk('reactivate')} students are active again.`, 'success'); } catch (error) { showToast(errorText(error), 'error'); }
});
$('#bulkDeactivateBtn').addEventListener('click', () => {
  const n = table.selected.length;
  askConfirm({ title: `Deactivate ${n} student${n === 1 ? '' : 's'}?`, text: 'They are hidden from lists and can no longer log in. Attendance history is kept. Use Reactivate to bring them back.',
    confirmLabel: 'Deactivate', cancelLabel: 'Keep active', failText: 'Could not deactivate. Try again.',
    run: async () => { showToast(`${await bulk('deactivate')} students deactivated.`, 'success'); } });
});
$('#bulkMoveBtn').addEventListener('click', () => {
  const classId = $('#bulkClass').value;
  if (!classId) { showToast('Choose a class to move them to.', 'error'); $('#bulkClass').focus(); return; }
  const n = table.selected.length;
  const label = $('#bulkClass').selectedOptions[0].textContent;
  askConfirm({ title: `Move ${n} student${n === 1 ? '' : 's'} to ${label}?`, text: 'They are added to that class. Their batch (G1/G2) for that class is cleared, so split batches again afterwards.',
    confirmLabel: 'Move', cancelLabel: 'Cancel', danger: false, failText: 'Could not move them. Try again.',
    run: async () => { showToast(`${await bulk('set_class', { classId: Number(classId) })} students moved.`, 'success'); } });
});

// ---------------- Add / edit dialog ----------------
const dialog = $('#entityDialog');
let editing = null;

// Plain-language rules, checked on the page and again by the server
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const lowerFirst = text => text.charAt(0).toLowerCase() + text.slice(1);

function problemWith(field, input) {
  if (field.type === 'checkbox') return '';
  const value = input.value.trim();
  const label = lowerFirst(field.label);
  if (!value) {
    if (field.type === 'password' || !field.required) return ''; // a blank password is generated / kept
    return field.type === 'select' ? `Choose a ${label}.` : `Enter the ${label}.`;
  }
  if (field.type === 'email' && !EMAIL.test(value)) return 'Enter a valid email address, like name@college.edu.';
  if (field.type === 'tel' && !/^\+?\d{10,13}$/.test(value.replace(/[\s()-]/g, ''))) return 'Enter a valid phone number: 10 digits, optionally starting with +91.';
  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n)) return 'Enter a whole number.';
    const { min, max } = field;
    if ((min && n < min) || (max && n > max)) return `${field.label} must be between ${min} and ${max}.`;
  }
  if (field.name === 'username' && !/^[A-Za-z0-9._-]{3,30}$/.test(value)) return 'Use 3 to 30 letters, numbers, dots, dashes or underscores, with no spaces.';
  if (field.type === 'password') {
    if (value.length < 6) return 'Use at least 6 characters.';
    if (value.toLowerCase() === 'password') return 'Choose something other than "password".';
  }
  return '';
}

function control(field, value) {
  let input;
  if (field.type === 'checkbox') {
    input = h('input', { type: 'checkbox' });
    input.checked = value == null ? Boolean(field.default) : Boolean(value);
  } else if (field.type === 'select' || field.name === 'year_of_passing') {
    input = h('select'); // year of passing: a short list, filled by wireYearOfPassing()
    if (field.type === 'select') { fillSelect(input, field.options || [], field.required ? 'Choose…' : 'None'); input.value = value ?? ''; }
  } else {
    input = h('input', { type: field.type === 'password' ? 'password' : field.type || 'text', autocomplete: 'off' });
    if (field.min) input.min = field.min;
    if (field.max) input.max = field.max;
    if (field.type === 'password') { input.autocomplete = 'new-password'; input.placeholder = editing ? 'Leave blank to keep the current password' : 'Leave blank to generate one'; }
    else input.value = value ?? (editing ? '' : field.default ?? '');
  }
  input.id = `ef-${field.name}`;
  input.dataset.field = field.name;
  if (field.type !== 'checkbox') input.classList.add('input');
  return input;
}

// Password field with an eye inside it (show / hide). There is no Generate button here: a new person gets a generated
// password when this is left blank, and "Reset password" on their row makes a new one later.
const EYE_ON = '<svg class="eye-on" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg class="eye-off" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function passwordRow(input) {
  const eye = h('button', { class: 'input-toggle', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', 'aria-controls': input.id });
  eye.innerHTML = EYE_ON + EYE_OFF;
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.querySelector('.eye-on').hidden = show;
    eye.querySelector('.eye-off').hidden = !show;
  });
  return h('div', { class: 'input-group' }, input, eye);
}

// ---- Year of passing: worked out from the class, with a short list to change it ----
// year = start year of the class's session + course length - year of study + 1 (Sem 5 in 2026-27, 4-year course: 2028)
function wireYearOfPassing(row) {
  const yearSel = $('#ef-year_of_passing');
  const classSel = $('#ef-class_id');
  if (!yearSel || !classSel) return;
  const classes = classOptions();
  let touched = Boolean(row?.year_of_passing); // an existing student keeps the stored year until someone changes it
  const derive = () => {
    const c = classes.find(o => String(o.value) === classSel.value);
    const start = Number(/^(\d{4})/.exec(c?.session || '')?.[1]);
    return c && start ? start + Number(c.duration) - Math.ceil(Number(c.semester) / 2) + 1 : null;
  };
  const fill = () => {
    const derived = derive();
    // With a class: the year it points to, one earlier and two later (a student repeating a year). Without one:
    // from this academic year on, long enough to cover every year of study.
    const first = currentTerm(meta.today).startYear;
    const years = derived ? [derived - 1, derived, derived + 1, derived + 2] : Array.from({ length: 6 }, (_, i) => first + i);
    const keep = touched ? yearSel.value || String(row?.year_of_passing ?? '') : '';
    if (keep && !years.includes(Number(keep))) years.push(Number(keep)); // never silently drop a stored value
    years.sort((a, b) => a - b);
    fillSelect(yearSel, years.map(y => ({ value: y, label: y === derived ? `${y} (from the class)` : String(y) })), 'Choose…');
    yearSel.value = touched ? keep : derived ?? '';
  };
  yearSel.addEventListener('change', () => { touched = true; });
  classSel.addEventListener('change', fill);
  fill();
  if (row?.year_of_passing) yearSel.value = String(row.year_of_passing);
}

// ---- Faculty abbreviation: say at once if somebody else has it ----
function wireAbbrCheck() {
  const abbr = $('#ef-abbr');
  if (!abbr) return;
  let timer = 0;
  let latest = 0;
  abbr.addEventListener('input', () => {
    clearTimeout(timer);
    const value = abbr.value.trim();
    latest++;
    if (!value) return setFieldMsg(abbr.id, '');
    timer = setTimeout(async () => {
      const mine = latest;
      try {
        const r = await api(`/api/admin/master/abbr-check?abbr=${encodeURIComponent(value)}${editing ? `&exclude=${editing.id}` : ''}`);
        if (mine !== latest) return; // the admin kept typing
        setFieldMsg(abbr.id, r.available ? `${value} is free.` : `${value} is already used by ${r.owner}.`, r.available ? 'ok' : 'err');
      } catch {
        if (mine === latest) setFieldMsg(abbr.id, '');
      }
    }, 350);
  });
}

// ---- New password for one person ----
function askReset(row) {
  askConfirm({
    title: `Reset ${row.name}'s password?`,
    text: 'A new random password is made now and the old one stops working at once. You will see the new one once, to hand over.',
    confirmLabel: 'Reset password', cancelLabel: 'Keep it', danger: false,
    failText: 'Could not reset the password. Try again.',
    run: async () => {
      const r = await api('/api/admin/master/passwords', { method: 'POST', body: { entity: active, ids: [row.id] } });
      const p = r.passwords[0];
      if (p) showCredentials({ name: p.name, username: p.username, password: p.password });
    },
  });
}

function openEditor(row) {
  editing = row;
  const entity = meta.entities[active];
  $('#entityTitle').textContent = `${row ? 'Edit' : 'Add'} ${entity.singular}`;
  setBox('entityError', '');
  $('#entityFields').replaceChildren(...entity.fields.map(f => {
    const input = control(f, row?.[f.name]);
    // Hint and error live under the field and are tied to it for screen readers
    // The server's password hint talks about "keeping the current one", which is wrong for a new record
    const hint = f.type === 'password'
      ? (row ? 'Leave blank to keep the current password. To give them a new one, use Reset password on their row.' : 'Leave blank and a secure password is generated for you to hand over.')
      : f.hint;
    const hintEl = hint ? h('p', { class: 'adm-help', id: `${input.id}-hint`, text: hint }) : null;
    const msg = h('p', { class: 'field-msg err', id: `${input.id}-msg`, role: 'alert', hidden: true });
    input.setAttribute('aria-describedby', [hintEl && hintEl.id, msg.id].filter(Boolean).join(' '));
    if (f.required && f.type !== 'checkbox') input.setAttribute('aria-required', 'true');
    const wrap = f.type === 'checkbox'
      ? h('label', { class: 'adm-check-field', for: input.id }, input, f.label)
      : h('div', { class: 'field' }, h('label', { for: input.id, text: f.label + (f.required ? '' : ' (optional)') }), f.type === 'password' ? passwordRow(input) : input);
    if (hintEl) wrap.append(hintEl);
    wrap.append(msg);
    if (f.type === 'checkbox') wrap.classList.add('adm-span2'); // (the password sits beside the username)
    return wrap;
  }));
  // Convenience: a new student's username defaults to their roll number
  const roll = $('#ef-roll_number');
  roll?.addEventListener('blur', () => { const u = $('#ef-username'); if (u && !u.value) u.value = roll.value.trim().toLowerCase(); });
  if (active === 'students') wireYearOfPassing(row);
  if (active === 'faculties') wireAbbrCheck();
  dialog.showModal();
  $('#entityFields input:not([type=checkbox]), #entityFields select')?.focus();
}
$('#entityCancelBtn').addEventListener('click', () => dialog.close());

// ---------------- Hand-over dialog for generated passwords ----------------
const credDialog = $('#credDialog');
function showCredentials({ name, username, password }) {
  $('#credIntro').textContent = `${name} can now sign in with these details.`;
  $('#credUser').textContent = username;
  $('#credPass').textContent = password;
  $('#credCopyBtn').textContent = 'Copy password';
  credDialog.showModal();
}
$('#credCopyBtn').addEventListener('click', async event => {
  const ok = await copyText($('#credPass').textContent);
  event.currentTarget.textContent = ok ? 'Copied ✓' : 'Select the password and copy it';
  if (ok) showToast('Password copied.', 'success');
});
$('#credCloseBtn').addEventListener('click', () => credDialog.close());

$('#entityForm').addEventListener('submit', async event => {
  event.preventDefault();
  const entity = meta.entities[active];
  setBox('entityError', '');
  // Check every field and show every problem at once, then move to the first one
  let firstBad = null;
  for (const f of entity.fields) {
    const input = $(`#ef-${f.name}`);
    const problem = problemWith(f, input);
    setFieldMsg(input.id, problem);
    if (problem && !firstBad) firstBad = input;
  }
  if (firstBad) { firstBad.focus(); return; }

  const body = {};
  for (const f of entity.fields) {
    const input = $(`#ef-${f.name}`);
    body[f.name] = f.type === 'checkbox' ? input.checked : input.value.trim();
  }
  const button = $('#entitySaveBtn');
  setBusy(button, true);
  try {
    const result = await api(`/api/admin/master/entity/${active}${editing ? '/' + editing.id : ''}`, { method: editing ? 'PUT' : 'POST', body });
    const typedPassword = $('#ef-password')?.dataset.generated ? body.password : '';
    const handover = result.generatedPassword || typedPassword;
    dialog.close();
    showToast(editing ? 'Saved changes.' : `Added ${entity.singular}.`, 'success');
    refresh();
    if (active === 'branches' || active === 'courses' || active === 'rooms' || active === 'classes') loadMeta(true).catch(() => {});
    if (handover) showCredentials({ name: body.name, username: body.username, password: handover });
  } catch (error) {
    // "That roll number is already in use." belongs under the roll number field
    const taken = error.code === 'duplicate' && /^That (.+) is already in use/.exec(error.message || '');
    const field = taken && entity.fields.find(f => f.name.replaceAll('_', ' ') === taken[1]);
    if (field) { setFieldMsg(`ef-${field.name}`, error.message); $(`#ef-${field.name}`).focus(); }
    else if (error.code === 'duplicate' && active === 'faculties' && /is already used by/.test(error.message || '')) { setFieldMsg('ef-abbr', error.message); $('#ef-abbr').focus(); } // "AMG" is already used by Mr. ...
    else setBox('entityError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});

function askRemove(row) {
  const entity = meta.entities[active];
  const student = SOFT.includes(active);
  const who = softNoun();
  const name = row.name || row.abbr || row.code || row.label || 'this ' + entity.singular;
  askConfirm({
    title: `${student ? 'Deactivate' : 'Delete'} ${name}?`,
    text: student ? `The ${who} is hidden from lists and can no longer log in. History is kept. Use Reactivate to bring them back.` : 'This cannot be undone. Items used elsewhere (for example a class with students) cannot be deleted.',
    confirmLabel: student ? 'Deactivate' : 'Delete',
    cancelLabel: student ? 'Keep active' : 'Keep',
    failText: student ? 'Could not deactivate. Try again.' : 'Could not delete. Try again.',
    run: async () => {
      try {
        await api(`/api/admin/master/entity/${active}/${row.id}`, { method: 'DELETE' });
      } catch (error) {
        throw Object.assign(error, { message: errorText(error) });
      }
      showToast(student ? `${name} deactivated.` : 'Deleted.', 'success');
      refresh();
    },
  });
}

async function reactivate(row) {
  try {
    await api(`/api/admin/master/entity/${active}/${row.id}`, { method: 'PUT', body: { active: true } });
    showToast(`${row.name} is active again.`, 'success');
    refresh();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

// ---------------- Term setup wizard ----------------
// Session -> classes (branch + semester) -> students for each -> sections with their home rooms.
const wizard = $('#wizardDialog');
const WIZ_LAST = 4;
let step = 1;
let wizRows = [];
let cohorts = [];
const SECTION_OK = /^[A-Z0-9][A-Z0-9-]{0,7}$/;
// The academic year starts in July: July-December is the ODD term of that year, January-June is the EVEN term
// of the year that began the July before. Change this one number if the college's year starts in another month.
const ACADEMIC_YEAR_START_MONTH = 7;
const YEARS_AHEAD = 2; // how many academic years after the current one are offered

// The term running on `today` (a YYYY-MM-DD date from the server): { startYear, term }
function currentTerm(today) {
  const [y, m] = today.split('-').map(Number);
  const startYear = m >= ACADEMIC_YEAR_START_MONTH ? y : y - 1;
  const oddMonths = m >= ACADEMIC_YEAR_START_MONTH;
  return { startYear, term: oddMonths ? 'ODD' : 'EVEN' };
}
// Is this term the current one or a later one? Earlier terms are not offered.
const termIsCurrentOrLater = (startYear, term, now) =>
  startYear > now.startYear || (startYear === now.startYear && (term === now.term || term === 'EVEN'));
const sessionName = (startYear, term) => `${startYear}-${startYear + 1} ${term}`;

const wizSessionValue = () => sessionName(Number($('#wizYear').value), document.querySelector('input[name="wizTerm"]:checked')?.value || 'ODD');

// Year list from the current academic year on; ODD/EVEN radios with the already-finished term switched off
function fillSessionPicker(preferred) {
  const now = currentTerm(meta.today);
  const years = Array.from({ length: YEARS_AHEAD + 1 }, (_, i) => now.startYear + i);
  const has = y => ['ODD', 'EVEN'].some(t => meta.sessions.includes(sessionName(y, t)));
  fillSelect($('#wizYear'), years.map(y => ({ value: y, label: `${y}-${y + 1}${has(y) ? ' (has classes)' : ''}` })));
  const m = /^(\d{4})-\d{4} (ODD|EVEN)$/.exec(preferred || '');
  const wanted = m && termIsCurrentOrLater(Number(m[1]), m[2], now) ? { year: Number(m[1]), term: m[2] } : { year: now.startYear, term: now.term };
  $('#wizYear').value = wanted.year;
  syncTermChoices(wanted.term);
}
function syncTermChoices(prefer) {
  const now = currentTerm(meta.today);
  const year = Number($('#wizYear').value);
  for (const input of document.querySelectorAll('input[name="wizTerm"]')) {
    const allowed = termIsCurrentOrLater(year, input.value, now);
    input.disabled = !allowed;
    input.closest('label').classList.toggle('is-off', !allowed);
  }
  const first = [...document.querySelectorAll('input[name="wizTerm"]')].find(i => !i.disabled);
  const chosen = [...document.querySelectorAll('input[name="wizTerm"]')].find(i => i.value === prefer && !i.disabled) || first;
  if (chosen) chosen.checked = true;
}
$('#wizYear').addEventListener('change', () => syncTermChoices(document.querySelector('input[name="wizTerm"]:checked')?.value));

const branchOptions = () => meta.entities.classes.fields.find(f => f.name === 'branch_id').options;
const roomOptions = () => meta.entities.classes.fields.find(f => f.name === 'room_id').options;
const branchLabel = id => branchOptions().find(b => String(b.value) === String(id))?.label.split(' / ').pop() || '';

// ---- step 2: which branches and semesters run this term ----
function renderWizRows() {
  $('#wizRows').replaceChildren(...wizRows.map((row, i) => {
    const branch = h('select', { class: 'input', 'aria-label': `Branch, row ${i + 1}`, onchange: e => (row.branchId = e.target.value) });
    fillSelect(branch, branchOptions(), 'Branch');
    branch.value = row.branchId;
    const sem = h('select', { class: 'input', 'aria-label': `Semester, row ${i + 1}`, onchange: e => (row.semester = e.target.value) });
    fillSelect(sem, [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ value: n, label: `Semester ${n}` })), 'Semester');
    sem.value = row.semester;
    return h('div', { class: 'adm-wiz-line' }, branch, sem,
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Remove', 'aria-label': `Remove row ${i + 1}`, disabled: wizRows.length === 1, onclick: () => { wizRows.splice(i, 1); renderWizRows(); } }));
  }));
}

// ---- step 3: students of each branch + semester ----
function renderStudents() {
  $('#wizStudents').replaceChildren(...cohorts.map(c => {
    const free = c.students.filter(s => !s.assignedTo);
    const count = h('strong');
    const sync = () => { count.textContent = `${c.picked.size} of ${free.length} selected`; };
    const boxes = [];
    const list = h('div', { class: 'adm-pick-grid adm-wiz-list' }, ...c.students.map(s => {
      const box = h('input', { type: 'checkbox', checked: c.picked.has(s.id), disabled: Boolean(s.assignedTo),
        onchange: e => { if (e.target.checked) c.picked.add(s.id); else c.picked.delete(s.id); sync(); } });
      boxes.push([s, box]);
      return h('label', { class: 'adm-pick' }, box, h('span', {}, `${s.name} `, h('small', { class: 'adm-help', text: s.roll_number || '' }),
        ...(s.assignedTo ? [' ', h('span', { class: 'badge', text: `already in ${s.assignedTo}` })] : [])));
    }));
    const setAll = on => { c.picked = new Set(on ? free.map(s => s.id) : []); boxes.forEach(([s, box]) => { if (!s.assignedTo) box.checked = on; }); sync(); };
    sync();
    return h('section', { class: 'adm-wiz-cohort', 'aria-label': c.label },
      h('div', { class: 'adm-wiz-head' },
        h('div', {}, h('strong', { text: c.label }), h('span', { class: 'adm-help', text: `Passing year ${c.passingYear} (${c.durationYears}-year course)` })),
        h('span', { class: 'adm-wiz-tools' }, count,
          h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'All', onclick: () => setAll(true) }),
          h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'None', onclick: () => setAll(false) }))),
      c.students.length
        ? h('div', { class: 'adm-picklist' }, list)
        : h('p', { class: 'adm-empty', text: `No active students have ${c.passingYear} as their passing year. You can still create the classes and add students later.` }));
  }));
}

// ---- step 4: sections and home rooms ----
function evenSplit(c) {
  const n = c.sections.length;
  const total = c.picked.size;
  c.sections.forEach((sec, i) => (sec.count = String(Math.floor(total / n) + (i < total % n ? 1 : 0))));
}
function renderSections() {
  const rooms = roomOptions();
  $('#wizSections').replaceChildren(...cohorts.map(c => {
    const note = h('p', { class: 'adm-help' });
    const sync = () => {
      const sum = c.sections.reduce((n, s) => n + (Number(s.count) || 0), 0);
      note.textContent = `${c.picked.size} student${c.picked.size === 1 ? '' : 's'} to place` + (c.sections.length > 1 ? ` · ${sum} placed${sum === c.picked.size ? '' : ' (should be ' + c.picked.size + ')'}` : '');
      note.classList.toggle('err', sum !== c.picked.size && c.sections.length > 1);
    };
    const lines = c.sections.map((sec, i) => {
      const label = h('input', { class: 'input', type: 'text', placeholder: 'Section', maxlength: 8, autocomplete: 'off', 'aria-label': `Section, ${c.label} row ${i + 1}`, value: sec.section,
        oninput: e => (sec.section = e.target.value.toUpperCase()) });
      const room = h('select', { class: 'input', 'aria-label': `Home room, ${c.label} section ${sec.section || i + 1}`, onchange: e => (sec.roomId = e.target.value) });
      fillSelect(room, rooms, 'No home room');
      room.value = sec.roomId;
      const nStudents = h('input', { class: 'input', type: 'number', min: 0, 'aria-label': `Students, ${c.label} section ${sec.section || i + 1}`, value: c.sections.length === 1 ? c.picked.size : sec.count,
        disabled: c.sections.length === 1, oninput: e => { sec.count = e.target.value; sync(); } });
      return h('div', { class: 'adm-wiz-line adm-wiz-line-sec' }, label, room, nStudents,
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Remove', disabled: c.sections.length === 1, onclick: () => { c.sections.splice(i, 1); evenSplit(c); renderSections(); } }));
    });
    sync();
    return h('section', { class: 'adm-wiz-cohort', 'aria-label': c.label },
      h('div', { class: 'adm-wiz-head' }, h('strong', { text: c.label }), note),
      ...lines,
      h('div', { class: 'adm-wiz-tools' },
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Add section', onclick: () => { c.sections.push({ section: '', roomId: '', count: '0' }); evenSplit(c); renderSections(); } }),
        ...(c.sections.length > 1 ? [h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Split evenly', onclick: () => { evenSplit(c); renderSections(); } })] : [])));
  }));
}

function wizGo(n) {
  step = n;
  $$('.adm-step[data-step]', wizard).forEach(el => (el.hidden = Number(el.dataset.step) !== n));
  $$('#wizardSteps li').forEach(li => {
    const k = Number(li.dataset.step);
    li.toggleAttribute('data-done', k < n || n > WIZ_LAST);
    if (k === Math.min(n, WIZ_LAST)) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  $('#wizBack').hidden = n === 1 || n > WIZ_LAST;
  $('#wizNext').hidden = n >= WIZ_LAST;
  $('#wizCreate').hidden = n !== WIZ_LAST;
  $('#wizCancel').hidden = n > WIZ_LAST;
  $('#wizClose').hidden = n <= WIZ_LAST;
  setBox('wizardError', '');
}

async function openWizard() {
  await loadMeta();
  fillSessionPicker(defaultSession());
  wizRows = [{ branchId: '', semester: '' }];
  cohorts = [];
  renderWizRows();
  wizGo(1);
  wizard.showModal();
  $('#wizYear').focus();
}
$('#wizardBtn').addEventListener('click', openWizard);
$('#wizAddRow').addEventListener('click', () => { wizRows.push({ branchId: '', semester: '' }); renderWizRows(); });
$('#wizCancel').addEventListener('click', () => wizard.close());
$('#wizClose').addEventListener('click', () => wizard.close());
$('#wizBack').addEventListener('click', () => wizGo(step - 1));

async function nextFromClasses() {
  const seen = new Set();
  const rows = wizRows.filter(r => r.branchId && r.semester);
  if (!rows.length || rows.length !== wizRows.length) { $('#wizRowsMsg').textContent = rows.length ? 'Every row needs a branch and a semester.' : 'Add at least one branch and semester.'; $('#wizRowsMsg').hidden = false; return; }
  for (const r of rows) {
    const key = `${r.branchId}|${r.semester}`;
    if (seen.has(key)) { $('#wizRowsMsg').textContent = 'The same branch and semester is listed twice.'; $('#wizRowsMsg').hidden = false; return; }
    seen.add(key);
  }
  $('#wizRowsMsg').hidden = true;
  const session = wizSessionValue();
  const previous = new Map(cohorts.map(c => [c.key, c]));
  cohorts = await Promise.all(rows.map(async r => {
    const key = `${r.branchId}|${r.semester}`;
    const found = await api(`/api/admin/master/wizard-students?session=${encodeURIComponent(session)}&branchId=${r.branchId}&semester=${r.semester}`);
    const old = previous.get(key);
    const free = found.students.filter(s => !s.assignedTo);
    const keep = old ? new Set([...old.picked].filter(id => free.some(s => s.id === id))) : new Set(free.map(s => s.id));
    return { key, branchId: r.branchId, semester: r.semester, label: `${found.branch} · Semester ${found.semester}`, passingYear: found.passingYear, durationYears: found.durationYears,
      students: found.students, picked: keep, sections: old?.sections || [{ section: '', roomId: '', count: '0' }] };
  }));
  renderStudents();
  wizGo(3);
}

function sectionsProblem() {
  const roomSection = new Map();
  for (const c of cohorts) {
    const labels = new Set();
    const sum = c.sections.reduce((n, s) => n + (Number(s.count) || 0), 0);
    for (const sec of c.sections) {
      const name = sec.section.trim().toUpperCase();
      if (!SECTION_OK.test(name)) return `${c.label}: give every section a short label (like A, B or 3).`;
      if (labels.has(name)) return `${c.label}: section ${name} is listed twice.`;
      labels.add(name);
      if (sec.roomId) {
        const other = roomSection.get(sec.roomId);
        if (other && other !== name) return `A home room can hold one section only. ${roomOptions().find(r => String(r.value) === String(sec.roomId))?.label} is used for both ${other} and ${name}.`;
        roomSection.set(sec.roomId, name);
      }
    }
    if (c.sections.length > 1 && sum !== c.picked.size) return `${c.label}: the sections hold ${sum} students but ${c.picked.size} are selected.`;
  }
  return '';
}

$('#wizardForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (step === 1) {
    $('#wizSession-msg').hidden = true; // year and term are both always set, so there is nothing to type wrong
    renderWizRows();
    return wizGo(2);
  }
  if (step === 2) {
    try { return await nextFromClasses(); } catch (error) { return setBox('wizardError', errorText(error)); }
  }
  if (step === 3) { renderSections(); cohorts.forEach(c => { if (c.sections.length > 1) evenSplit(c); }); renderSections(); return wizGo(4); }

  const problem = sectionsProblem();
  if (problem) return setBox('wizardError', problem);
  const button = $('#wizCreate');
  setBusy(button, true);
  try {
    const session = wizSessionValue();
    const body = { session, cohorts: cohorts.map(c => {
      const ids = c.students.filter(s => c.picked.has(s.id)).map(s => s.id); // in roll-number order
      let at = 0;
      return { branchId: c.branchId, semester: c.semester, sections: c.sections.map(sec => {
        const take = c.sections.length === 1 ? ids.length : Number(sec.count) || 0;
        const part = ids.slice(at, at + take);
        at += take;
        return { section: sec.section.trim().toUpperCase(), roomId: sec.roomId, studentIds: part };
      }) };
    }) };
    const result = await api('/api/admin/master/wizard-apply', { method: 'POST', body });
    await loadMeta(true);
    cache.classes = false;
    cache.students = false;
    const status = await api(`/api/admin/master/term-status?session=${encodeURIComponent(session)}`);
    const next = (label, detail, action, fn) => h('li', {}, h('span', { class: 'adm-check-text' }, h('strong', { text: label }), h('span', { text: detail })), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: action, onclick: () => { wizard.close(); fn(); } }));
    $('#wizDone').replaceChildren(
      h('p', { class: 'adm-big', text: `${result.created} class${result.created === 1 ? '' : 'es'} created, ${result.assigned} student${result.assigned === 1 ? '' : 's'} placed` }),
      h('p', { class: 'adm-help', text: [result.existing ? `${result.existing} class${result.existing === 1 ? '' : 'es'} already existed.` : '', result.skipped ? `${result.skipped} student${result.skipped === 1 ? ' was' : 's were'} skipped because they were already in a class this term.` : ''].filter(Boolean).join(' ') || 'Next, finish the term in this order:' }),
      h('ol', { class: 'adm-checklist' },
        next('Subjects & faculty', `${status.subjects} subjects, ${status.faculty} faculty on file`, 'Open subjects', () => switchTab('subjects')),
        next('Timetable', 'Build it in the grid, one classroom at a time', 'Open timetable', () => goto('timetable'))));
    wizGo(WIZ_LAST + 1);
    const select = $('#termSession');
    await loadTerm();
    select.value = session;
    loadTerm();
    if (active === 'classes' || active === 'students') refresh();
  } catch (error) {
    setBox('wizardError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});
