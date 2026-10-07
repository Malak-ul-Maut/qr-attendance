// master.js - term setup + one table per kind of record (students, faculty, subjects, classes ...).
import { $, $$, h, api, createDataTable, askConfirm, rowActions, setBusy, setBox, setFieldMsg, errorText, fillSelect, showToast, maskSecrets, generatePassword, copyText, announce } from './core.js';
import { openImport } from './import.js';

const goto = view => document.dispatchEvent(new CustomEvent('admin:goto', { detail: view }));
let meta = null;
let active = 'students';
let rows = [];
const cache = {};
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
  const steps = [];
  const step = (done, label, detail, action, onclick) => {
    steps.push(done);
    return h('li', { class: done ? 'done' : '' },
      h('span', { class: 'adm-check', 'aria-hidden': 'true', text: done ? '✓' : '' }),
      h('span', { class: 'adm-check-text' }, h('strong', { text: label }), h('span', { text: detail })),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: action, onclick }));
  };
  $('#termSteps').replaceChildren(
    step(s.classes > 0, 'Classes', s.classes ? `${s.classes} classes in ${s.session}` : 'No classes in this session yet', s.classes ? 'View' : 'Set up', () => (s.classes ? switchTab('classes') : openWizard())),
    step(s.subjects > 0, 'Subjects', `${s.subjects} subjects`, 'Manage', () => switchTab('subjects')),
    step(s.faculty > 0, 'Faculty', `${s.faculty} faculty`, 'Manage', () => switchTab('faculties')),
    step(s.students > 0, 'Students', `${s.students} students in this session`, 'Manage', () => switchTab('students')),
    step(s.classes > 0 && s.classesWithTimetable >= s.classes, 'Timetable', `${s.classesWithTimetable} of ${s.classes} classes have a timetable`, 'Open', () => goto('timetable')),
    ...(s.batchNeeded > 0 ? [step(s.batchAssigned >= s.batchNeeded, 'Lab batches', `${s.batchAssigned} of ${s.batchNeeded} students have a G1/G2 batch (lab attendance needs it)`, 'Split batches…', () => openSplit(select.value))] : []),
  );
  // Once every step is done the checklist is only noise above the table: fold it into one line.
  const allDone = steps.every(Boolean);
  const sessionKey = select.value;
  const folded = allDone && !termManual.has(sessionKey); // an admin who pressed "Show checklist" keeps it open
  $('#termSummary').hidden = !allDone;
  $('#termSteps').hidden = folded;
  $('#termSummaryText').textContent = `✓ Term setup is complete for ${sessionKey} (${steps.length} of ${steps.length} steps).`;
  $('#termToggleBtn').textContent = folded ? 'Show checklist' : 'Hide checklist';
  $('#termToggleBtn').setAttribute('aria-expanded', String(!folded));
}
const termManual = new Set();
$('#termToggleBtn').addEventListener('click', () => {
  const key = $('#termSession').value;
  if (termManual.has(key)) termManual.delete(key); else termManual.add(key);
  const open = termManual.has(key);
  $('#termSteps').hidden = !open;
  $('#termToggleBtn').textContent = open ? 'Hide checklist' : 'Show checklist';
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

function makeTable() {
  const entity = meta.entities[active];
  const columns = entity.columns.map(([key, label]) => ({
    key, label, sortable: true, get: r => r[key],
    ...(key === 'status' ? { render: (r, td) => td.append(h('span', { class: `badge ${r.active ? 'badge-success' : ''}`, text: r.status })) } : {}),
    ...(['periods', 'semester', 'students'].includes(key) ? { num: true } : {}),
    ...(key === 'camera_url' ? { clip: true, get: r => maskSecrets(r.camera_url), render: renderCameraUrl } : {}),
  }));
  const students = active === 'students';
  columns.push({ key: 'actions', label: 'Actions', render: (r, td) => {
    const name = r.name || r.label || r.abbr || r.code || `#${r.id}`;
    // Students are never deleted (their attendance history is kept), so the button says what it does
    const opts = !students ? {} : r.active ? { removeLabel: 'Deactivate' } : { removeLabel: 'Reactivate', removeKind: 'secondary' };
    td.append(rowActions(entity.singular, r, name, openEditor, students && !r.active ? reactivate : askRemove, opts));
  } });
  table = createDataTable({ mount: $('#masterTable'), noun: entity.singular, pageSize: 12, columns, selectable: students, onSelect: updateBulk, emptyHint: `Select "Add" to create the first ${entity.singular}.`, onRetry: () => loadRows() });
}

async function loadRows() {
  if (!cache[active]) table.setLoading();
  try {
    ({ rows } = await api(`/api/admin/master/entity/${active}`));
    cache[active] = true;
    table.setRows(rows);
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
  $('#masterFilters').hidden = !students;
  $('#masterBulk').hidden = true;
  if (!students) return;
  fillSelect($('#masterClassFilter'), [{ value: '', label: 'All classes' }, { value: 'none', label: 'No class' }, ...classOptions()]);
  fillSelect($('#bulkClass'), classOptions(), 'Choose class…');
  $('#masterShowInactive').checked = false;
  $('#masterOnlyInactive').checked = false;
  $('#masterOnlyInactiveWrap').hidden = true;
}
function applyFilters() {
  if (active !== 'students' || !table) return;
  const cls = $('#masterClassFilter').value;
  const show = $('#masterShowInactive').checked;
  const only = $('#masterOnlyInactive').checked;
  const inactive = rows.filter(r => !r.active).length;
  $('#masterShowInactive').nextSibling.textContent = ` Show inactive students (${inactive})`;
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
  } else if (field.type === 'select') {
    input = h('select');
    fillSelect(input, field.options || [], field.required ? 'Choose…' : 'None');
    input.value = value ?? '';
  } else {
    input = h('input', { type: field.type === 'password' ? 'password' : field.type || 'text', autocomplete: 'off' });
    if (field.min) input.min = field.min;
    if (field.max) input.max = field.max;
    if (field.type === 'password') { input.autocomplete = 'new-password'; input.placeholder = editing ? 'Leave blank to keep the current password' : 'Leave blank to generate one'; }
    else input.value = value ?? '';
  }
  input.id = `ef-${field.name}`;
  input.dataset.field = field.name;
  if (field.type !== 'checkbox') input.classList.add('input');
  return input;
}

// Password row: the field, Show/Hide and a Generate button (a random password the admin can hand over)
function passwordRow(input) {
  const show = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Show', 'aria-pressed': 'false', 'aria-controls': input.id,
    onclick: () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      show.textContent = visible ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(visible));
    } });
  const generate = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Generate', 'aria-label': 'Generate a random password',
    onclick: () => {
      input.value = generatePassword();
      input.dataset.generated = '1';
      input.type = 'text';
      show.textContent = 'Hide';
      show.setAttribute('aria-pressed', 'true');
      setFieldMsg(input.id, '');
      input.focus();
      input.select();
    } });
  input.addEventListener('input', () => delete input.dataset.generated); // typing your own replaces the generated one
  return h('div', { class: 'adm-pw' }, input, show, generate);
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
      ? (row ? 'Leave blank to keep the current password. At least 6 characters.' : 'Leave blank and a secure password is generated for you to hand over.')
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
    if (f.type === 'checkbox') wrap.classList.add('adm-span2');
    return wrap;
  }));
  // Convenience: a new student's username defaults to their roll number
  const roll = $('#ef-roll_number');
  roll?.addEventListener('blur', () => { const u = $('#ef-username'); if (u && !u.value) u.value = roll.value.trim().toLowerCase(); });
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
    else setBox('entityError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});

function askRemove(row) {
  const entity = meta.entities[active];
  const student = active === 'students';
  const name = row.name || row.abbr || row.code || row.label || 'this ' + entity.singular;
  askConfirm({
    title: `${student ? 'Deactivate' : 'Delete'} ${name}?`,
    text: student ? 'The student is hidden from lists and can no longer log in. Attendance history is kept. Use Reactivate to bring them back.' : 'This cannot be undone. Items used elsewhere (for example a class with students) cannot be deleted.',
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
    await api(`/api/admin/master/entity/students/${row.id}`, { method: 'PUT', body: { active: true } });
    showToast(`${row.name} is active again.`, 'success');
    refresh();
  } catch (error) {
    showToast(errorText(error), 'error');
  }
}

// ---------------- Term setup wizard ----------------
const wizard = $('#wizardDialog');
let step = 1;
let wizRows = [];
// Sections are free labels (A, B, 3 ...), typed separated by commas
const SECTION_OK = /^[A-Z0-9][A-Z0-9-]{0,7}$/;
function parseSections(text) {
  const parts = [...new Set(String(text || '').toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  return { list: parts, bad: parts.filter(p => !SECTION_OK.test(p)) };
}
const SESSION_RE = /^(\d{4})-(\d{4}) (ODD|EVEN)$/;
const sessionProblem = value => {
  const m = SESSION_RE.exec(value);
  if (!value) return 'Choose the academic session.';
  if (!m) return 'Use the format 2026-2027 ODD (two years, then ODD or EVEN).';
  if (Number(m[2]) !== Number(m[1]) + 1) return 'The two years must be consecutive, like 2026-2027.';
  return '';
};
const wizSessionValue = () => ($('#wizSession').value === '__other' ? $('#wizSessionOther').value.trim().toUpperCase().replace(/\s+/g, ' ') : $('#wizSession').value);
function fillSessionPicker(preferred) {
  const year = new Date().getFullYear();
  const generated = [];
  for (let y = year + 1; y >= year - 1; y--) generated.push(`${y}-${y + 1} ODD`, `${y - 1}-${y} EVEN`);
  const all = [...new Set([...meta.sessions, ...generated])].sort((a, b) => b.localeCompare(a));
  fillSelect($('#wizSession'), [...all.map(v => ({ value: v, label: meta.sessions.includes(v) ? `${v} (has classes)` : v })), { value: '__other', label: 'Other (type it)…' }]);
  $('#wizSession').value = all.includes(preferred) ? preferred : all[0];
  $('#wizSessionOther').hidden = true;
  $('#wizSessionOther').value = '';
}
$('#wizSession').addEventListener('change', event => {
  const other = event.target.value === '__other';
  $('#wizSessionOther').hidden = !other;
  if (other) $('#wizSessionOther').focus();
});

function wizRow(row = { branchId: '', semester: '', sectionsText: '', roomId: '' }) {
  return row;
}
function renderWizRows() {
  const branches = meta.entities.classes.fields.find(f => f.name === 'branch_id').options;
  const rooms = meta.entities.classes.fields.find(f => f.name === 'room_id').options;
  $('#wizRows').replaceChildren(...wizRows.map((row, i) => {
    const branch = h('select', { class: 'input', 'aria-label': `Branch, row ${i + 1}`, onchange: e => (row.branchId = e.target.value) });
    fillSelect(branch, branches, 'Branch');
    branch.value = row.branchId;
    const sem = h('input', { class: 'input', type: 'number', min: 1, max: 8, placeholder: 'Sem', 'aria-label': `Semester, row ${i + 1}`, value: row.semester, oninput: e => (row.semester = e.target.value) });
    const room = h('select', { class: 'input', 'aria-label': `Home room, row ${i + 1}`, onchange: e => (row.roomId = e.target.value) });
    fillSelect(room, rooms, 'No home room');
    room.value = row.roomId;
    return h('div', { class: 'adm-wiz-row' },
      h('div', { class: 'adm-wiz-fields' }, branch, sem, room),
      h('div', { class: 'adm-wiz-sections' },
        h('input', { class: 'input', type: 'text', placeholder: 'Sections, e.g. A, B, C', 'aria-label': `Sections, row ${i + 1} (separate with commas)`, value: row.sectionsText, autocomplete: 'off', oninput: e => (row.sectionsText = e.target.value) }),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'A–E', title: 'Fill in A, B, C, D, E', 'aria-label': `Fill sections A to E, row ${i + 1}`,
          onclick: e => { row.sectionsText = 'A, B, C, D, E'; e.currentTarget.previousElementSibling.value = row.sectionsText; } })),
      h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Remove', 'aria-label': `Remove row ${i + 1}`, disabled: wizRows.length === 1, onclick: () => { wizRows.splice(i, 1); renderWizRows(); } }));
  }));
}

function wizGo(n) {
  step = n;
  $$('.adm-step[data-step]', wizard).forEach(el => (el.hidden = Number(el.dataset.step) !== n));
  $$('#wizardSteps li').forEach(li => {
    const k = Number(li.dataset.step);
    li.toggleAttribute('data-done', k < n || n === 4);
    if (k === Math.min(n, 3)) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  $('#wizBack').hidden = n === 1 || n === 4;
  $('#wizNext').hidden = n >= 3;
  $('#wizCreate').hidden = n !== 3;
  $('#wizCancel').hidden = n === 4;
  $('#wizClose').hidden = n !== 4;
  setBox('wizardError', '');
}

async function openWizard() {
  await loadMeta();
  fillSessionPicker(defaultSession());
  wizRows = [wizRow()];
  renderWizRows();
  wizGo(1);
  wizard.showModal();
  $('#wizSession').focus();
}
$('#wizardBtn').addEventListener('click', openWizard);
$('#wizAddRow').addEventListener('click', () => { wizRows.push(wizRow()); renderWizRows(); });
$('#wizCancel').addEventListener('click', () => wizard.close());
$('#wizClose').addEventListener('click', () => wizard.close());
$('#wizBack').addEventListener('click', () => wizGo(step - 1));

function validRows() {
  return wizRows
    .map(r => ({ ...r, sections: parseSections(r.sectionsText).list, badSections: parseSections(r.sectionsText).bad }))
    .filter(r => r.branchId && Number(r.semester) >= 1 && Number(r.semester) <= 8 && r.sections.length && !r.badSections.length);
}

$('#wizardForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (step === 1) {
    const value = wizSessionValue();
    const known = meta.sessions.includes(value);
    const problem = known ? '' : sessionProblem(value);
    $('#wizSession-msg').textContent = problem;
    $('#wizSession-msg').hidden = !problem;
    $('#wizSession-msg').className = 'field-msg err';
    ($('#wizSession').value === '__other' ? $('#wizSessionOther') : $('#wizSession')).toggleAttribute('aria-invalid', Boolean(problem));
    if (problem) return ($('#wizSession').value === '__other' ? $('#wizSessionOther') : $('#wizSession')).focus();
    return wizGo(2);
  }
  if (step === 2) {
    const ok = validRows();
    const bad = wizRows.length !== ok.length;
    const oddLabel = wizRows.some(r => parseSections(r.sectionsText).bad.length);
    $('#wizRowsMsg').hidden = !(bad || !ok.length);
    $('#wizRowsMsg').textContent = oddLabel ? 'A section label can use up to 8 letters, numbers or dashes (like A, B or 3).' : !ok.length ? 'Add at least one complete row.' : 'Each row needs a branch, a semester (1–8) and at least one section.';
    if (bad || !ok.length) return;
    const branches = meta.entities.classes.fields.find(f => f.name === 'branch_id').options;
    const total = ok.reduce((n, r) => n + r.sections.length, 0);
    $('#wizReview').replaceChildren(
      h('p', { text: `This will create ${total} class${total === 1 ? '' : 'es'} in ${wizSessionValue()}. Classes that already exist are left as they are.` }),
      h('ul', { class: 'adm-activity' }, ...ok.map(r => h('li', {},
        h('strong', { text: `${branches.find(b => String(b.value) === String(r.branchId)).label} · Sem ${r.semester}` }),
        h('span', { class: 'adm-when', text: `Sections ${r.sections.join(', ')}` })))));
    return wizGo(3);
  }
  const button = $('#wizCreate');
  setBusy(button, true);
  try {
    const session = wizSessionValue();
    const result = await api('/api/admin/master/term-setup', { method: 'POST', body: { session, items: validRows().map(r => ({ branchId: r.branchId, semester: r.semester, sections: r.sections, roomId: r.roomId })) } });
    await loadMeta(true);
    cache.classes = false;
    const status = await api(`/api/admin/master/term-status?session=${encodeURIComponent(session)}`);
    const next = (label, detail, action, fn) => h('li', {}, h('span', { class: 'adm-check-text' }, h('strong', { text: label }), h('span', { text: detail })), h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: action, onclick: () => { wizard.close(); fn(); } }));
    $('#wizDone').replaceChildren(
      h('p', { class: 'adm-big', text: `${result.created} class${result.created === 1 ? '' : 'es'} created` }),
      h('p', { class: 'adm-help', text: result.existing ? `${result.existing} already existed.` : 'Next, fill the term in this order:' }),
      h('ol', { class: 'adm-checklist' },
        next('Subjects & faculty', `${status.subjects} subjects, ${status.faculty} faculty on file`, 'Open subjects', () => switchTab('subjects')),
        next('Students', 'Add them one by one or import a CSV', 'Import students', () => { switchTab('students'); openImport('students', refresh); }),
        next('Timetable', 'Build it in the grid or import a CSV', 'Open timetable', () => goto('timetable'))));
    wizGo(4);
    const select = $('#termSession');
    await loadTerm();
    select.value = session;
    loadTerm();
    if (active === 'classes') loadRows();
  } catch (error) {
    setBox('wizardError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});
