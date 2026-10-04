// admin.js - the admin portal: dashboard, students, faculty, attendance, database.
// No alert(), confirm() or page reloads: messages are toasts / inline text,
// confirmations use <dialog>, and tables update in place after a change.

import { getCurrentUser, logout } from '/utils/storage.js';
import { showToast } from './ui.js';
import { createFaceModels, detectFaces, embedFace } from '/utils/face-onnx.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currentUser = getCurrentUser() || {};

// Small helper to build elements without innerHTML (so server text can never become markup)
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child != null));
  return node;
}

// Calls the backend and returns JSON. On failure throws an Error whose .code is the
// server's `error` value (for example "username_taken"), or "network" if it never answered.
async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), {
      code: 'network',
    });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error || 'Request failed.'), {
      code: body.error || 'http_' + response.status,
    });
  }
  return body;
}

// Shows or clears the red/green message under a form field
function setFieldMsg(id, text, kind = 'err') {
  const input = document.getElementById(id);
  const msg = document.getElementById(`${id}-msg`);
  if (!msg) return;
  msg.textContent = text || '';
  msg.hidden = !text;
  msg.className = `field-msg ${kind}`;
  if (input) {
    if (text && kind === 'err') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

// Shows or clears the red box at the bottom of a dialog
function setBox(id, text) {
  const box = document.getElementById(id);
  box.textContent = text || '';
  box.hidden = !text;
}

// Checks required fields, shows a message under each empty one and focuses the first.
// fields: [{ id, label, select }]. Returns true when everything is filled in.
function requireFields(fields) {
  let firstBad = null;
  for (const { id, label, select } of fields) {
    const input = document.getElementById(id);
    const empty = !input.value.trim();
    setFieldMsg(
      id,
      empty ? (select ? `Choose a ${label}.` : `Enter the ${label}.`) : '',
    );
    if (empty && !firstBad) firstBad = input;
  }
  firstBad?.focus();
  return !firstBad;
}

// Clear a field's message as soon as the person starts fixing it
document.addEventListener('input', event => {
  const id = event.target.id;
  if (id && document.getElementById(`${id}-msg`) && id !== 'faceImages')
    setFieldMsg(id, '');
});

// Show / hide password buttons
$$('[data-toggle-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(show));
  });
});

// Busy state for buttons: shows a spinner and blocks double clicks
const setBusy = (button, busy) => {
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
};

// ==================== Page basics and tabs ====================
$('.user-name b').textContent = currentUser.name || 'Admin';
$('.logout-btn').addEventListener('click', () => logout());

const VIEWS = ['dashboard', 'students', 'faculty', 'attendance', 'database'];
const VIEW_TITLES = {
  dashboard: 'Dashboard',
  students: 'Students',
  faculty: 'Faculty',
  attendance: 'Attendance',
  database: 'Database',
};
let viewLoaders = {}; // filled in below; each runs when its tab is opened

function showView(name, { moveFocus = false } = {}) {
  if (!VIEWS.includes(name)) name = 'dashboard';
  $$('.nav-item').forEach(item => {
    if (item.dataset.view === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  VIEWS.forEach(
    view => (document.getElementById(`view-${view}`).hidden = view !== name),
  );
  document.title = `${VIEW_TITLES[name]} | Admin`;
  // Remember the tab in the address so a refresh stays where you were
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (moveFocus) document.getElementById(`${name}Title`)?.focus();
  viewLoaders[name]?.();
}

$$('.nav-item').forEach(item =>
  item.addEventListener('click', () =>
    showView(item.dataset.view, { moveFocus: true }),
  ),
);
$$('[data-goto]').forEach(card =>
  card.addEventListener('click', () =>
    showView(card.dataset.goto, { moveFocus: true }),
  ),
);
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ==================== Dashboard ====================
async function loadStats() {
  $('#statsError').hidden = true;
  try {
    const { stats } = await api('/api/admin/stats');
    $('#studentCount').textContent = stats.students;
    $('#facultyCount').textContent = stats.faculty;
    $('#attendanceCount').textContent = stats.attendance;
    $('#liveSessionCount').textContent = stats.liveSessions;
    $('#liveSessionNote').textContent =
      stats.liveSessions > 0 ? 'Running now' : 'None running';
  } catch {
    $('#statsError').hidden = false;
  }
}
$('#statsRetryBtn').addEventListener('click', loadStats);

// HOOK: call when the backend can list recent events.
// items: [{ kind: 'Attendance' | 'Student' | 'Session' | ..., text, time }]  (time is display text)
export function renderActivity(items) {
  $('#activityEmpty').hidden = items.length > 0;
  $('#activityList').replaceChildren(
    ...items.map(item =>
      h(
        'li',
        {},
        h('span', { class: 'badge', text: item.kind }),
        h('span', { text: item.text }),
        h('span', { class: 'adm-when', text: item.time || '' }),
      ),
    ),
  );
}

// ==================== Data table (used for students, faculty, attendance) ====================
// columns: [{ key, label, get(row) -> text, sortable, num, clip, render(row, cell) }]
function createDataTable({
  mount,
  columns,
  noun,
  pageSize = 10,
  onRetry,
  emptyHint = '',
}) {
  const state = {
    rows: [],
    loading: true,
    error: false,
    query: '',
    filter: null,
    sortKey: null,
    sortDir: 1,
    page: 0,
    focusSort: null,
  };

  function visibleRows() {
    const query = state.query.trim().toLowerCase();
    let rows = state.rows.filter(row => !state.filter || state.filter(row));
    if (query) {
      rows = rows.filter(row =>
        columns.some(
          col =>
            col.get &&
            String(col.get(row) ?? '')
              .toLowerCase()
              .includes(query),
        ),
      );
    }
    if (state.sortKey) {
      const col = columns.find(c => c.key === state.sortKey);
      rows = [...rows].sort(
        (a, b) =>
          String(col.get(a) ?? '').localeCompare(
            String(col.get(b) ?? ''),
            undefined,
            { numeric: true, sensitivity: 'base' },
          ) * state.sortDir,
      );
    }
    return rows;
  }

  function render() {
    // Loading: grey placeholder rows (only on first load; later refreshes keep the old rows visible)
    if (state.loading && !state.rows.length) {
      mount.replaceChildren(
        h(
          'div',
          {
            class: 'adm-skeleton-rows',
            'aria-busy': 'true',
            'aria-label': `Loading ${noun}s`,
          },
          ...[1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton' })),
        ),
      );
      return;
    }
    if (state.error) {
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state', role: 'alert' },
          h('strong', { text: `Could not load ${noun}s` }),
          h('span', { text: 'Check your connection and try again.' }),
          h('button', {
            class: 'btn btn-secondary',
            type: 'button',
            text: 'Try again',
            onclick: () => onRetry?.(),
          }),
        ),
      );
      return;
    }
    if (!state.rows.length) {
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state' },
          h('strong', { text: `No ${noun}s yet` }),
          h('span', { text: emptyHint }),
        ),
      );
      return;
    }

    const rows = visibleRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    state.page = Math.min(state.page, pageCount - 1);
    const pageRows = rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );

    if (!rows.length) {
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state' },
          h('strong', { text: `No ${noun}s match` }),
          h('span', { text: 'Try a different search or filter.' }),
        ),
      );
      return;
    }

    const head = h(
      'tr',
      {},
      ...columns.map(col => {
        const th = h('th', { scope: 'col' });
        if (col.sortable) {
          th.setAttribute(
            'aria-sort',
            state.sortKey === col.key
              ? state.sortDir === 1
                ? 'ascending'
                : 'descending'
              : 'none',
          );
          th.append(
            h('button', {
              class: 'adm-sort',
              type: 'button',
              'data-sort': col.key,
              text: col.label,
              onclick: () => sortBy(col.key),
            }),
          );
        } else th.textContent = col.label;
        return th;
      }),
    );
    const body = h(
      'tbody',
      {},
      ...pageRows.map(row =>
        h(
          'tr',
          {},
          ...columns.map(col => {
            const td = h('td', {
              class:
                [col.num && 'adm-num', col.clip && 'adm-clip']
                  .filter(Boolean)
                  .join(' ') || false,
            });
            if (col.render) col.render(row, td);
            else {
              td.textContent = col.get(row) ?? '';
              if (col.clip) td.title = td.textContent;
            }
            return td;
          }),
        ),
      ),
    );

    const first = state.page * pageSize + 1;
    const last = Math.min(rows.length, first + pageSize - 1);
    const pager = h(
      'div',
      { class: 'adm-pager' },
      h('span', {
        role: 'status',
        text: `Showing ${first}–${last} of ${rows.length}`,
      }),
      h(
        'span',
        { class: 'adm-pager-btns' },
        h('button', {
          class: 'btn btn-secondary btn-sm',
          type: 'button',
          text: 'Previous',
          disabled: state.page === 0,
          onclick: () => go(-1),
        }),
        h('button', {
          class: 'btn btn-secondary btn-sm',
          type: 'button',
          text: 'Next',
          disabled: state.page >= pageCount - 1,
          onclick: () => go(1),
        }),
      ),
    );

    mount.replaceChildren(
      h(
        'div',
        {
          class: 'adm-table-wrap',
          tabindex: '0',
          role: 'region',
          'aria-label': `${noun} list`,
        },
        h('table', { class: 'adm-table' }, h('thead', {}, head), body),
      ),
      pager,
    );
    // After re-sorting, put keyboard focus back on the heading button that was used
    if (state.focusSort)
      mount.querySelector(`[data-sort="${state.focusSort}"]`)?.focus();
    state.focusSort = null;
  }

  function sortBy(key) {
    state.sortDir = state.sortKey === key ? -state.sortDir : 1;
    state.sortKey = key;
    state.focusSort = key;
    render();
  }
  function go(step) {
    state.page += step;
    render();
  }

  return {
    render,
    setRows(rows) {
      state.rows = rows;
      state.loading = false;
      state.error = false;
      render();
    },
    setLoading() {
      state.loading = true;
      state.error = false;
      render();
    },
    setError() {
      state.loading = false;
      state.error = true;
      render();
    },
    setQuery(query) {
      state.query = query;
      state.page = 0;
      render();
    },
    setFilter(fn) {
      state.filter = fn;
      state.page = 0;
      render();
    },
    get rows() {
      return visibleRows();
    },
  };
}

// ==================== Confirm-delete dialog (shared) ====================
const deleteDialog = $('#deleteDialog');
let deleteAction = null;

// run: async function that performs the delete; the dialog stays open (with a spinner) until it finishes
function askDelete({ title, text, run }) {
  $('#deleteTitle').textContent = title;
  $('#deleteText').textContent = text;
  setBox('deleteError', '');
  deleteAction = run;
  deleteDialog.showModal();
}
$('#deleteCancelBtn').addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('cancel', event => {
  if ($('#deleteConfirmBtn').getAttribute('aria-busy')) event.preventDefault(); // don't close mid-delete
});
$('#deleteConfirmBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true);
  setBox('deleteError', '');
  try {
    await deleteAction();
    deleteDialog.close();
  } catch (error) {
    setBox(
      'deleteError',
      error.code === 'network'
        ? 'Could not reach the server. Try again.'
        : 'Could not delete. Try again.',
    );
  } finally {
    setBusy(button, false);
  }
});

// Row buttons: Edit is a normal button, Delete is outlined red so the two never look alike
function rowActions(noun, row, name, onEdit, onDelete) {
  return h(
    'div',
    { class: 'adm-actions' },
    h('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      text: 'Edit',
      'aria-label': `Edit ${noun} ${name}`,
      onclick: () => onEdit(row),
    }),
    h('button', {
      class: 'btn btn-danger btn-sm',
      type: 'button',
      text: 'Delete',
      'aria-label': `Delete ${noun} ${name}`,
      onclick: () => onDelete(row),
    }),
  );
}

// ==================== Students ====================
const STUDENTS_API = '/api/students';
let students = [];
let studentMeta = null; // { courses, branches, classes } for the form and table labels
let studentsLoaded = false;
let editingStudent = null; // the student being edited, or null when adding
let studentStep = 1;
let faceFiles = []; // { file, url } objects chosen in step 3
let modelsPromise = null;

const lookup = (list, id, field = 'label') =>
  list?.find(item => String(item.id) === String(id))?.[field];
const branchLabel = s =>
  lookup(studentMeta?.branches, s.branchId) || s.branch || s.branchId || '';
const classLabel = s => {
  const section =
    s.section ||
    (studentMeta?.classes.find(c => String(c.id) === String(s.classId))
      ?.section ??
      '');
  return (
    [s.semester ? `Sem ${s.semester}` : '', section]
      .filter(Boolean)
      .join(' · ') || (s.classId ? `Class ${s.classId}` : '')
  );
};

const studentTable = createDataTable({
  mount: $('#studentsTable'),
  noun: 'student',
  emptyHint: 'Select "Add student" to create the first one.',
  onRetry: () => loadStudents(),
  columns: [
    { key: 'name', label: 'Name', sortable: true, get: s => s.name },
    {
      key: 'username',
      label: 'Username',
      sortable: true,
      get: s => s.username,
    },
    {
      key: 'roll',
      label: 'Roll no.',
      sortable: true,
      num: true,
      get: s => s.rollNumber,
    },
    { key: 'branch', label: 'Branch', sortable: true, get: branchLabel },
    { key: 'class', label: 'Class', sortable: true, get: classLabel },
    {
      key: 'actions',
      label: 'Actions',
      render: (s, td) =>
        td.append(
          rowActions('student', s, s.name, openStudentEditor, askDeleteStudent),
        ),
    },
  ],
});

async function loadStudentMeta() {
  if (studentMeta) return studentMeta;
  studentMeta = await api(`${STUDENTS_API}/meta`);
  fillSelect('studentCourse', studentMeta.courses, 'Select course');
  fillSelect('studentBranch', studentMeta.branches, 'Select branch');
  $('#studentBranchFilter').replaceChildren(
    new Option('All branches', ''),
    ...studentMeta.branches.map(b => new Option(b.label, b.id)),
  );
  return studentMeta;
}

function fillSelect(id, options, placeholder) {
  $(`#${id}`).replaceChildren(
    new Option(placeholder, ''),
    ...options.map(o => new Option(o.label, o.id)),
  );
}

async function loadStudents() {
  if (!studentsLoaded) studentTable.setLoading();
  try {
    // Labels need the course/branch list, but a failure there should not hide the students
    const [list] = await Promise.all([
      api(STUDENTS_API),
      loadStudentMeta().catch(() => null),
    ]);
    students = list;
    studentsLoaded = true;
    studentTable.setRows(students);
  } catch {
    if (!studentsLoaded) studentTable.setError();
    else showToast('Could not refresh students.', 'error');
  }
}

$('#studentSearch').addEventListener('input', e =>
  studentTable.setQuery(e.target.value),
);
$('#studentBranchFilter').addEventListener('change', e => {
  const branch = e.target.value;
  studentTable.setFilter(branch ? s => String(s.branchId) === branch : null);
});

// ---- Class dropdown depends on course + branch + semester ----
function updateMatchingClasses() {
  if (!studentMeta) return;
  const courseId = $('#studentCourse').value;
  const branchId = $('#studentBranch').value;
  const semester = Number($('#studentSemester').value);
  const matching = studentMeta.classes.filter(
    c =>
      String(c.course_id) === courseId &&
      String(c.branch_id) === branchId &&
      c.semester === semester,
  );
  const ready = courseId && branchId && semester;
  const previous = $('#studentClass').value; // keep the chosen class if it still matches
  fillSelect(
    'studentClass',
    matching.map(c => ({ id: c.id, label: `Class ${c.id} - ${c.section}` })),
    ready
      ? matching.length
        ? 'Select class'
        : 'No classes match these choices'
      : 'Select course, branch, and semester first',
  );
  if (matching.some(c => String(c.id) === previous))
    $('#studentClass').value = previous;
  $('#studentClass').disabled = matching.length === 0;
}
['studentCourse', 'studentBranch', 'studentSemester'].forEach(id =>
  $(`#${id}`).addEventListener('change', updateMatchingClasses),
);
$('#studentSemester').addEventListener('input', updateMatchingClasses);

// ---- Username availability ----
let usernameCheckId = 0;
// Returns true (free), false (taken) or null (could not check; the server will decide on save)
async function checkStudentUsername() {
  const username = $('#studentUsername').value.trim();
  if (!username || (editingStudent && username === editingStudent.username)) {
    setFieldMsg('studentUsername', '');
    return true;
  }
  const mine = ++usernameCheckId;
  setFieldMsg('studentUsername', 'Checking username…', 'info');
  try {
    const { available } = await api(
      `${STUDENTS_API}/username-available?username=${encodeURIComponent(username)}`,
    );
    if (mine !== usernameCheckId) return null; // a newer check replaced this one
    setFieldMsg(
      'studentUsername',
      available ? 'Username is available' : 'Username is already in use',
      available ? 'ok' : 'err',
    );
    return available;
  } catch {
    if (mine === usernameCheckId) setFieldMsg('studentUsername', '');
    return null;
  }
}
$('#studentUsername').addEventListener('blur', () => {
  if ($('#studentModal').open) checkStudentUsername();
});

// ---- Face models: start loading when the form opens so Save is not slow ----
// Loads a classic <script> on demand and resolves when it has run
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(tag);
  });
}
function ensureModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      if (!window.ort) {
        await loadScript('/utils/ort/ort.wasm.min.js');
      }
      if (typeof cacheModelsFromManifest === 'undefined') {
        await loadScript('/utils/cache-models.js');
      }
      const cached = await cacheModelsFromManifest(
        '/utils/models/models-manifest.json',
      );
      if (!cached) throw new Error('Could not prepare the face models.');
      return createFaceModels();
    })().catch(error => {
      modelsPromise = null; // allow a retry next time
      throw error;
    });
  }
  return modelsPromise;
}

// ---- Photo previews ----
function renderFacePreviews(results = new Map()) {
  $('#facePreviews').replaceChildren(
    ...faceFiles.map((item, index) => {
      const result = results.get(item);
      return h(
        'li',
        { class: 'adm-preview' },
        h('img', {
          src: item.url,
          alt: `Photo ${index + 1}: ${item.file.name}`,
        }),
        h('button', {
          class: 'adm-remove',
          type: 'button',
          'aria-label': `Remove photo ${index + 1}`,
          text: '×',
          onclick: () => removeFace(item),
        }),
        result &&
          h('span', {
            class: `badge ${result.ok ? 'badge-success' : 'badge-danger'}`,
            text: result.ok ? '✓ Face found' : '✕ No clear face',
          }),
      );
    }),
  );
  const count = faceFiles.length;
  $('#faceStatus').textContent = count
    ? `${count} photo${count === 1 ? '' : 's'} selected${count < 3 ? ' (3 or more recommended)' : ''}`
    : editingStudent
      ? 'No new photos. The current face data will be kept.'
      : 'No photos selected';
}
function removeFace(item) {
  URL.revokeObjectURL(item.url);
  faceFiles = faceFiles.filter(f => f !== item);
  setFieldMsg('faceImages', '');
  renderFacePreviews();
}
function clearFaces() {
  faceFiles.forEach(f => URL.revokeObjectURL(f.url));
  faceFiles = [];
  $('#faceImages').value = '';
  renderFacePreviews();
}
$('#faceImages').addEventListener('change', event => {
  const added = [...event.target.files].filter(file =>
    file.type.startsWith('image/'),
  );
  faceFiles.push(
    ...added.map(file => ({ file, url: URL.createObjectURL(file) })),
  );
  event.target.value = ''; // so choosing the same photo again still fires
  setFieldMsg('faceImages', '');
  renderFacePreviews();
});

function loadFaceImage(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.name}`));
    };
    image.src = url;
  });
}

// Finds one face in each photo and computes its normalized w600k_mbf embedding.
async function getDescriptors() {
  const models = await ensureModels();
  const descriptors = [];
  const results = new Map();
  for (let i = 0; i < faceFiles.length; i++) {
    $('#faceStatus').textContent =
      `Checking photo ${i + 1} of ${faceFiles.length}…`;
    const item = faceFiles[i];
    const img = await loadFaceImage(item.file);
    const faces = await detectFaces(img, models.detector, 0.7);
    const detection = faces.length === 1 ? faces[0] : null;
    const ok = Boolean(detection);
    results.set(item, { ok });
    if (ok)
      descriptors.push(await embedFace(img, detection, models.recognizer));
    img.src = '';
  }
  renderFacePreviews(results);
  return descriptors;
}

// Average and normalize the enrolled embeddings into one 512-value template.
function computeCentroid(descriptors) {
  const centroid = new Float32Array(descriptors[0].length);
  for (let i = 0; i < centroid.length; i++) {
    centroid[i] = descriptors.reduce((sum, d) => sum + d[i], 0);
  }
  let norm = 0;
  for (let i = 0; i < centroid.length; i++) {
    centroid[i] /= descriptors.length;
    norm += centroid[i] * centroid[i];
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm < 1e-12)
    throw new Error('Could not build the face template.');
  for (let i = 0; i < centroid.length; i++) centroid[i] /= norm;
  return centroid;
}

const readDataUrl = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

// ---- Stepped form ----
const studentModal = $('#studentModal');
const STEP_FIELDS = {
  1: [
    { id: 'studentName', label: 'full name' },
    { id: 'studentUsername', label: 'username' },
    { id: 'studentPassword', label: 'password', editOptional: true },
    { id: 'studentRollNumber', label: 'roll number' },
  ],
  2: [
    { id: 'studentCourse', label: 'course', select: true },
    { id: 'studentBranch', label: 'branch', select: true },
    { id: 'studentSemester', label: 'semester' },
    { id: 'studentClass', label: 'class', select: true },
  ],
};

function goToStep(step) {
  studentStep = step;
  $$('.adm-step[data-step]', studentModal).forEach(
    el => (el.hidden = Number(el.dataset.step) !== step),
  );
  $$('#studentSteps li').forEach(li => {
    const n = Number(li.dataset.step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.toggleAttribute('data-done', n < step);
  });
  $('#studentBackBtn').hidden = step === 1;
  $('#studentNextBtn').hidden = step === 3;
  $('#saveStudentBtn').hidden = step !== 3;
  setBox('studentFormError', '');
  // Step 3 needs the face models, so warm them up now
  if (step === 3) ensureModels().catch(() => {});
  $(
    '.adm-step[data-step="' +
      step +
      '"] :is(input:not(.visually-hidden), select):not(:disabled)',
    studentModal,
  )?.focus();
}

// Checks the current step. Returns true when the person may continue.
async function validateStudentStep(step) {
  const fields = (STEP_FIELDS[step] || []).filter(
    f => !(editingStudent && f.editOptional),
  );
  if (!requireFields(fields)) return false;
  if (step === 1) {
    const free = await checkStudentUsername();
    if (free === false) {
      $('#studentUsername').focus();
      return false;
    }
  }
  if (step === 2) {
    const semester = Number($('#studentSemester').value);
    if (!Number.isInteger(semester) || semester < 1 || semester > 8) {
      setFieldMsg('studentSemester', 'Enter a semester from 1 to 8.');
      $('#studentSemester').focus();
      return false;
    }
  }
  return true;
}

function resetStudentForm() {
  [
    'studentName',
    'studentUsername',
    'studentPassword',
    'studentRollNumber',
    'studentCourse',
    'studentBranch',
    'studentSemester',
  ].forEach(id => ($(`#${id}`).value = ''));
  [...STEP_FIELDS[1], ...STEP_FIELDS[2], { id: 'faceImages' }].forEach(f =>
    setFieldMsg(f.id, ''),
  );
  $('#studentPassword').type = 'password';
  $('[data-toggle-password="studentPassword"]').textContent = 'Show';
  $('#studentPassword').placeholder = '';
  updateMatchingClasses();
  clearFaces();
}

async function openStudentForm(student) {
  editingStudent = student;
  resetStudentForm();
  $('#studentModalTitle').textContent = student
    ? 'Edit student'
    : 'Add student';
  if (student) {
    $('#studentName').value = student.name || '';
    $('#studentUsername').value = student.username || '';
    $('#studentPassword').value = student.password || '';
    $('#studentPassword').placeholder =
      'Leave blank to keep the current password';
    $('#studentRollNumber').value = student.rollNumber || '';
    $('#studentCourse').value = student.courseId ?? '';
    $('#studentBranch').value = student.branchId ?? '';
    $('#studentSemester').value = student.semester ?? '';
    updateMatchingClasses();
    $('#studentClass').value = student.classId ?? '';
  }
  goToStep(1);
  studentModal.showModal();
  // The course/branch lists may not have loaded yet (or failed earlier): try again now
  if (!studentMeta) {
    try {
      await loadStudentMeta();
      if (student) {
        $('#studentCourse').value = student.courseId ?? '';
        $('#studentBranch').value = student.branchId ?? '';
        updateMatchingClasses();
        $('#studentClass').value = student.classId ?? '';
      }
    } catch {
      setBox(
        'studentFormError',
        'Could not load course and branch options. Close this window and try again.',
      );
    }
  }
}
const openStudentEditor = student => openStudentForm(student);
$('#addStudentBtn').addEventListener('click', () => openStudentForm(null));
$('#closeStudentModalBtn').addEventListener('click', () =>
  studentModal.close(),
);
$('#studentBackBtn').addEventListener('click', () => goToStep(studentStep - 1));
studentModal.addEventListener('close', clearFaces);
studentModal.addEventListener('cancel', event => {
  if ($('#saveStudentBtn').getAttribute('aria-busy')) event.preventDefault();
});

// Enter / the Next button moves forward; on the last step it saves
$('#studentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (studentStep < 3) {
    const next = $('#studentNextBtn');
    setBusy(next, true);
    const ok = await validateStudentStep(studentStep);
    setBusy(next, false);
    if (ok) goToStep(studentStep + 1);
  } else {
    await saveStudent();
  }
});

async function saveStudent() {
  const saveBtn = $('#saveStudentBtn');
  setBox('studentFormError', '');

  // Photos are required for a new student; optional when editing
  if (!editingStudent && faceFiles.length === 0) {
    setFieldMsg('faceImages', 'Add at least one photo.');
    return;
  }

  const data = {
    name: $('#studentName').value.trim(),
    username: $('#studentUsername').value.trim(),
    rollNumber: $('#studentRollNumber').value.trim(),
    courseId: $('#studentCourse').value,
    branchId: $('#studentBranch').value,
    semester: $('#studentSemester').value,
    classId: $('#studentClass').value,
  };
  // When editing, a blank password means "keep the current one"
  const password = $('#studentPassword').value;
  if (password || !editingStudent) data.password = password;

  setBusy(saveBtn, true);
  const controls = $$('#studentForm button:not(#saveStudentBtn)');
  controls.forEach(b => (b.disabled = true));
  let descriptors = [];
  try {
    if (faceFiles.length) {
      try {
        await ensureModels();
      } catch {
        setBox(
          'studentFormError',
          'The face tools could not be loaded. Check your connection and try again.',
        );
        return;
      }
      descriptors = await getDescriptors();
      if (descriptors.length === 0) {
        setFieldMsg(
          'faceImages',
          'No clear face was found. Remove unclear photos and add front-facing ones.',
        );
        return;
      }
      data.faceDescriptor = JSON.stringify(
        Array.from(computeCentroid(descriptors)),
      );
    }

    // Photos are only uploaded when creating (same as before)
    if (!editingStudent)
      data.faceImages = await Promise.all(
        faceFiles.map(f => readDataUrl(f.file)),
      );

    const url = editingStudent
      ? `${STUDENTS_API}/${encodeURIComponent(editingStudent.username)}`
      : STUDENTS_API;
    await api(url, {
      method: editingStudent ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    const wasEditing = Boolean(editingStudent);
    studentModal.close();
    showToast(
      wasEditing ? `Saved changes to ${data.name}.` : `Added ${data.name}.`,
      'success',
    );
    if (descriptors.length && descriptors.length < 3)
      showToast(
        `Only ${descriptors.length} clear photo${descriptors.length === 1 ? ' was' : 's were'} found. 3 or more works best.`,
        'info',
        6000,
      );
    loadStudents();
    loadStats();
  } catch (error) {
    if (error.code === 'username_taken') {
      goToStep(1);
      setFieldMsg('studentUsername', 'Username is already in use');
      $('#studentUsername').focus();
    } else {
      setBox(
        'studentFormError',
        error.code === 'network'
          ? 'Could not reach the server. Try again.'
          : 'Could not save the student. Try again.',
      );
    }
  } finally {
    setBusy(saveBtn, false);
    controls.forEach(b => (b.disabled = false));
    if (!faceFiles.length) renderFacePreviews();
  }
}

function askDeleteStudent(student) {
  askDelete({
    title: `Delete ${student.name}?`,
    text: 'This removes the student account. It cannot be undone.',
    run: async () => {
      await api(`${STUDENTS_API}/${encodeURIComponent(student.username)}`, {
        method: 'DELETE',
      });
      students = students.filter(s => s.username !== student.username);
      studentTable.setRows(students); // remove the row without reloading
      showToast(`Deleted ${student.name}.`, 'success');
      loadStats();
    },
  });
}

// ==================== Faculty ====================
const FACULTY_API = '/api/faculty';
let faculty = [];
let facultyLoaded = false;
let editingFaculty = null;
const facultyModal = $('#facultyModal');
const FACULTY_FIELDS = [
  { id: 'facultyName', label: 'full name' },
  { id: 'facultyUsername', label: 'username' },
  { id: 'facultyPassword', label: 'password', editOptional: true },
  { id: 'facultySubject', label: 'subject' },
  { id: 'facultySection', label: 'section' },
];

const facultyTable = createDataTable({
  mount: $('#facultyTable'),
  noun: 'faculty member',
  emptyHint: 'Select "Add faculty" to create the first one.',
  onRetry: () => loadFaculty(),
  columns: [
    { key: 'name', label: 'Name', sortable: true, get: f => f.name },
    {
      key: 'username',
      label: 'Username',
      sortable: true,
      get: f => f.username,
    },
    {
      key: 'subject',
      label: 'Subject',
      sortable: true,
      get: f => f.subjectName,
    },
    { key: 'section', label: 'Section', sortable: true, get: f => f.section },
    {
      key: 'actions',
      label: 'Actions',
      render: (f, td) =>
        td.append(
          rowActions(
            'faculty member',
            f,
            f.name,
            openFacultyForm,
            askDeleteFaculty,
          ),
        ),
    },
  ],
});

async function loadFaculty() {
  if (!facultyLoaded) facultyTable.setLoading();
  try {
    faculty = await api(FACULTY_API);
    facultyLoaded = true;
    facultyTable.setRows(faculty);
  } catch {
    if (!facultyLoaded) facultyTable.setError();
    else showToast('Could not refresh faculty.', 'error');
  }
}
$('#facultySearch').addEventListener('input', e =>
  facultyTable.setQuery(e.target.value),
);

function openFacultyForm(member = null) {
  editingFaculty = member;
  FACULTY_FIELDS.forEach(f => setFieldMsg(f.id, ''));
  setBox('facultyFormError', '');
  $('#facultyModalTitle').textContent = member ? 'Edit faculty' : 'Add faculty';
  $('#facultyName').value = member?.name || '';
  $('#facultyUsername').value = member?.username || '';
  $('#facultyPassword').value = member?.password || '';
  $('#facultyPassword').placeholder = member
    ? 'Leave blank to keep the current password'
    : '';
  $('#facultyPassword').type = 'password';
  $('[data-toggle-password="facultyPassword"]').textContent = 'Show';
  $('#facultySubject').value = member?.subjectName || '';
  $('#facultySection').value = member?.section || '';
  facultyModal.showModal();
  $('#facultyName').focus();
}
$('#addFacultyBtn').addEventListener('click', () => openFacultyForm(null));
$('#closeFacultyModalBtn').addEventListener('click', () =>
  facultyModal.close(),
);
facultyModal.addEventListener('cancel', event => {
  if ($('#saveFacultyBtn').getAttribute('aria-busy')) event.preventDefault();
});

$('#facultyForm').addEventListener('submit', async event => {
  event.preventDefault();
  setBox('facultyFormError', '');
  if (
    !requireFields(
      FACULTY_FIELDS.filter(f => !(editingFaculty && f.editOptional)),
    )
  )
    return;

  const data = {
    username: $('#facultyUsername').value.trim(),
    name: $('#facultyName').value.trim(),
    subjectName: $('#facultySubject').value.trim(),
    section: $('#facultySection').value.trim(),
  };
  const password = $('#facultyPassword').value;
  if (password || !editingFaculty) data.password = password;

  const saveBtn = $('#saveFacultyBtn');
  setBusy(saveBtn, true);
  try {
    const url = editingFaculty
      ? `${FACULTY_API}/${encodeURIComponent(editingFaculty.username)}`
      : FACULTY_API;
    await api(url, {
      method: editingFaculty ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const wasEditing = Boolean(editingFaculty);
    facultyModal.close();
    showToast(
      wasEditing ? `Saved changes to ${data.name}.` : `Added ${data.name}.`,
      'success',
    );
    loadFaculty();
    loadStats();
  } catch (error) {
    if (error.code === 'username_taken') {
      setFieldMsg('facultyUsername', 'Username is already in use');
      $('#facultyUsername').focus();
    } else {
      setBox(
        'facultyFormError',
        error.code === 'network'
          ? 'Could not reach the server. Try again.'
          : 'Could not save the faculty member. Try again.',
      );
    }
  } finally {
    setBusy(saveBtn, false);
  }
});

function askDeleteFaculty(member) {
  askDelete({
    title: `Delete ${member.name}?`,
    text: 'This removes the faculty account. It cannot be undone.',
    run: async () => {
      await api(`${FACULTY_API}/${encodeURIComponent(member.username)}`, {
        method: 'DELETE',
      });
      faculty = faculty.filter(f => f.username !== member.username);
      facultyTable.setRows(faculty);
      showToast(`Deleted ${member.name}.`, 'success');
      loadStats();
    },
  });
}

// ==================== Attendance reports ====================
// There is no backend route for reports yet, so this screen works on whatever rows it is given.
// To connect it, do ONE of these:
//   1. setAttendanceLoader(async ({ from, to, method }) => rows)   - Apply will call it
//   2. renderAttendanceReport(rows)                               - push rows in yourself
// rows: [{ date: 'YYYY-MM-DD', subject, className, faculty, method: 'qr'|'cctv', present, total }]
let attendanceLoader = null;
let attendanceRows = [];

const pct = row =>
  row.total ? Math.round((row.present / row.total) * 100) : 0;
const attendanceTable = createDataTable({
  mount: $('#attendanceTable'),
  noun: 'session',
  emptyHint: 'Choose a date range and select Apply to see attendance.',
  onRetry: () => $('#attendanceFilters').requestSubmit(),
  columns: [
    { key: 'date', label: 'Date', sortable: true, get: r => r.date },
    { key: 'subject', label: 'Subject', sortable: true, get: r => r.subject },
    { key: 'class', label: 'Class', sortable: true, get: r => r.className },
    { key: 'faculty', label: 'Faculty', sortable: true, get: r => r.faculty },
    {
      key: 'method',
      label: 'Method',
      sortable: true,
      get: r => (r.method || '').toUpperCase(),
    },
    {
      key: 'count',
      label: 'Present',
      num: true,
      get: r => `${r.present}/${r.total}`,
    },
    {
      key: 'pct',
      label: 'Attendance',
      sortable: true,
      num: true,
      get: r => String(pct(r)).padStart(3, '0'),
      render: (r, td) => {
        const value = pct(r);
        const level =
          value >= 75
            ? ['good', 'success']
            : value >= 60
              ? ['mid', 'warning']
              : ['low', 'danger'];
        td.append(
          h('span', {
            class: `badge badge-${level[1]} adm-pct adm-pct-${level[0]}`,
            text: `${value}%`,
          }),
        );
      },
    },
  ],
});
attendanceTable.setRows([]);

export function setAttendanceLoader(loader) {
  attendanceLoader = loader;
}
export function renderAttendanceReport(rows) {
  attendanceRows = rows;
  attendanceTable.setRows(rows);
  const has = rows.length > 0;
  $('#attSummary').hidden = !has;
  $('#exportCsvBtn').disabled = !has;
  $('#attSessions').textContent = rows.length;
  $('#attAverage').textContent = has
    ? `${Math.round(rows.reduce((sum, r) => sum + pct(r), 0) / rows.length)}%`
    : '0%';
}

$('#attendanceFilters').addEventListener('submit', async event => {
  event.preventDefault();
  if (!attendanceLoader) {
    showToast('Attendance reports are not connected yet.', 'info');
    return;
  }
  const from = $('#attFrom').value;
  const to = $('#attTo').value;
  if (from && to && from > to) {
    showToast('The "From" date must be before the "To" date.', 'error');
    return;
  }
  const apply = $('#attApplyBtn');
  setBusy(apply, true);
  attendanceTable.setLoading();
  try {
    renderAttendanceReport(
      await attendanceLoader({ from, to, method: $('#attMethod').value }),
    );
  } catch {
    attendanceTable.setError();
  } finally {
    setBusy(apply, false);
  }
});

// Spreadsheet programs run text that starts with = + - or @ as a formula, so defuse those
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
$('#exportCsvBtn').addEventListener('click', () => {
  const header = [
    'Date',
    'Subject',
    'Class',
    'Faculty',
    'Method',
    'Present',
    'Total',
    'Attendance %',
  ];
  const lines = attendanceTable.rows.map(r =>
    [
      r.date,
      r.subject,
      r.className,
      r.faculty,
      r.method,
      r.present,
      r.total,
      pct(r),
    ]
      .map(csvCell)
      .join(','),
  );
  const blob = new Blob(
    ['\ufeff' + [header.map(csvCell).join(','), ...lines].join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  );
  const link = h('a', {
    href: URL.createObjectURL(blob),
    download: `attendance-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  showToast('CSV downloaded.', 'success');
});

// ==================== Database browser ====================
let databaseTables = [];
let activeDatabaseTable = null;
let activeDatabasePage = 0;
let activeDatabaseSearch = '';
let databaseSearchTimer = null;
let editingDatabaseRow = null;
let databaseRequestId = 0; // used to ignore answers that arrive late

const rowModal = $('#databaseRowModal');

function setDatabaseStatus(message, isError = false) {
  const status = $('#databaseStatus');
  status.textContent = message;
  status.classList.toggle('err', isError && Boolean(message));
}

async function showDatabase() {
  if (!currentUser.adminToken) {
    setDatabaseStatus(
      'Sign out and sign in again as admin to access the database.',
      true,
    );
    return;
  }
  if (databaseTables.length) return; // already loaded; keep the page and search as they were
  await loadDatabaseTables();
}

async function databaseRequest(url, options = {}) {
  try {
    return await api(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${currentUser.adminToken || ''}`,
      },
    });
  } catch (error) {
    const messages = {
      admin_login_required: 'Sign in again as admin to manage database rows.',
      invalid_admin_token: 'Your admin session is invalid. Sign in again.',
      expired_admin_token: 'Your admin session expired. Sign in again.',
      invalid_reference: 'Choose a valid value for each referenced field.',
      row_conflict_or_invalid_reference:
        'The row conflicts with existing data or a reference is invalid.',
      required_value_missing: 'Complete all required fields.',
      primary_key_is_immutable: 'Primary keys cannot be changed.',
      network: 'Could not reach the server.',
    };
    throw new Error(messages[error.code] || 'Database request failed.');
  }
}

// keepSelection: after saving a row, refresh the counts but stay on the same table and page
async function loadDatabaseTables(keepSelection = false) {
  setDatabaseStatus('Loading database tables…');
  try {
    const result = await databaseRequest('/api/admin/database/tables');
    const selectedName = keepSelection ? activeDatabaseTable?.name : null;
    databaseTables = result.tables;
    const select = $('#databaseTableSelect');
    select.replaceChildren(
      ...databaseTables.map(
        t => new Option(`${humanize(t.name)} (${t.rowCount})`, t.name),
      ),
    );
    activeDatabaseTable =
      databaseTables.find(t => t.name === selectedName) ||
      databaseTables[0] ||
      null;
    if (!keepSelection) activeDatabasePage = 0;
    if (activeDatabaseTable) select.value = activeDatabaseTable.name;
    $('#databaseAddRowBtn').disabled = !activeDatabaseTable;
    await refreshDatabaseRows();
  } catch (error) {
    setDatabaseStatus(error.message, true);
  }
}

async function refreshDatabaseRows() {
  if (!activeDatabaseTable) {
    setDatabaseStatus('There are no tables to show.');
    return;
  }
  const mine = ++databaseRequestId;
  setDatabaseStatus('Loading rows…');
  const query = new URLSearchParams({
    page: String(activeDatabasePage),
    pageSize: '50',
    search: activeDatabaseSearch,
  });
  try {
    const result = await databaseRequest(
      `/api/admin/database/tables/${encodeURIComponent(activeDatabaseTable.name)}/rows?${query}`,
    );
    if (mine !== databaseRequestId) return;
    renderDatabaseRows(result.rows);
    const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
    $('#databasePageLabel').textContent =
      `${result.total} rows · page ${result.page + 1} of ${pageCount}`;
    $('#databasePreviousBtn').disabled = result.page === 0;
    $('#databaseNextBtn').disabled =
      (result.page + 1) * result.pageSize >= result.total;
    setDatabaseStatus('');
  } catch (error) {
    if (mine === databaseRequestId) setDatabaseStatus(error.message, true);
  }
}

function renderDatabaseRows(rows) {
  const columns = activeDatabaseTable.columns.filter(c => !c.sensitive);
  const primaryKey = activeDatabaseTable.columns.find(c => c.primaryKey);
  const table = h(
    'table',
    { class: 'adm-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...columns.map(c => h('th', { scope: 'col', text: humanize(c.name) })),
        h('th', { scope: 'col', text: 'Actions' }),
      ),
    ),
    h(
      'tbody',
      {},
      ...rows.map(row =>
        h(
          'tr',
          {},
          ...columns.map(c => {
            const value = row[c.name];
            const text = c.foreignKey
              ? referenceLabel(c.foreignKey.options, value)
              : value == null
                ? ''
                : String(value);
            return h('td', { class: 'adm-clip', title: text, text });
          }),
          h(
            'td',
            {},
            h('button', {
              class: 'btn btn-secondary btn-sm',
              type: 'button',
              text: 'Edit',
              'aria-label': `Edit row ${primaryKey ? row[primaryKey.name] : ''}`,
              onclick: () => openDatabaseRowEditor(row),
            }),
          ),
        ),
      ),
    ),
  );
  const container = $('#databaseRows');
  container.setAttribute(
    'aria-label',
    `${humanize(activeDatabaseTable.name)} rows`,
  );
  container.replaceChildren(table);
  if (!rows.length)
    container.append(h('p', { class: 'adm-empty', text: 'No rows found.' }));
}

function openDatabaseRowEditor(row = null) {
  const fields = $('#databaseRowFields');
  fields.replaceChildren();
  editingDatabaseRow = row;
  setBox('databaseRowError', '');
  $('#databaseRowModalTitle').textContent =
    `${row ? 'Edit' : 'Add'} ${humanize(activeDatabaseTable.name)} row`;

  activeDatabaseTable.columns.forEach(column => {
    if (!row && column.autoGenerated) return;
    const id = `database-field-${column.name}`;
    const control = createDatabaseField(column, row);
    control.id = id;
    control.classList.add('input');
    control.dataset.column = column.name;
    control.required = column.required && !(row && column.sensitive);
    if (column.primaryKey && row) control.disabled = true;
    if (column.sensitive && row)
      control.placeholder = 'Leave blank to keep the current value';
    const label = h('label', {
      for: id,
      text: `${humanize(column.name)}${column.sensitive ? ' (write-only)' : ''}`,
    });
    fields.append(h('div', { class: 'field' }, label, control));
  });
  rowModal.showModal();
  $('input:not(:disabled), select:not(:disabled), textarea', fields)?.focus();
}

function createDatabaseField(column, row) {
  if (column.foreignKey) {
    const select = h('select');
    select.add(new Option(column.required ? 'Choose a reference' : 'None', ''));
    column.foreignKey.options.forEach(o =>
      select.add(new Option(o.label, o.value)),
    );
    if (row && row[column.name] != null)
      select.value = String(row[column.name]);
    return select;
  }
  const control =
    column.sensitive && column.name === 'descriptor'
      ? h('textarea', { rows: '3' })
      : h('input');
  if (control instanceof HTMLInputElement) {
    control.type = column.sensitive
      ? 'password'
      : /INT/i.test(column.type)
        ? 'number'
        : 'text';
    if (/INT/i.test(column.type)) control.step = '1';
  }
  if (row && !column.sensitive && row[column.name] != null)
    control.value = String(row[column.name]);
  return control;
}

$('#databaseRowForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return; // browser shows which required field is empty
  const values = {};
  $$('#databaseRowFields [data-column]').forEach(control => {
    if (!control.disabled) values[control.dataset.column] = control.value;
  });
  const isEditing = Boolean(editingDatabaseRow);
  const primaryKey = activeDatabaseTable.columns.find(c => c.primaryKey);
  const path = `/api/admin/database/tables/${encodeURIComponent(activeDatabaseTable.name)}/rows`;
  const url = isEditing
    ? `${path}/${encodeURIComponent(editingDatabaseRow[primaryKey.name])}`
    : path;
  const saveBtn = $('#databaseSaveRowBtn');
  setBusy(saveBtn, true);
  setBox('databaseRowError', '');
  try {
    await databaseRequest(url, {
      method: isEditing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    rowModal.close();
    showToast(isEditing ? 'Row saved.' : 'Row added.', 'success');
    await loadDatabaseTables(true);
  } catch (error) {
    setBox('databaseRowError', error.message); // stays inside the dialog so the person can fix it
  } finally {
    setBusy(saveBtn, false);
  }
});

$('#databaseTableSelect').addEventListener('change', event => {
  activeDatabaseTable = databaseTables.find(t => t.name === event.target.value);
  activeDatabasePage = 0;
  refreshDatabaseRows();
});
$('#databaseSearch').addEventListener('input', event => {
  clearTimeout(databaseSearchTimer);
  databaseSearchTimer = setTimeout(() => {
    activeDatabaseSearch = event.target.value.trim();
    activeDatabasePage = 0;
    refreshDatabaseRows();
  }, 200);
});
$('#databaseAddRowBtn').addEventListener('click', () => {
  if (activeDatabaseTable) openDatabaseRowEditor();
});
$('#databasePreviousBtn').addEventListener('click', () => {
  if (activeDatabasePage > 0) {
    activeDatabasePage -= 1;
    refreshDatabaseRows();
  }
});
$('#databaseNextBtn').addEventListener('click', () => {
  activeDatabasePage += 1;
  refreshDatabaseRows();
});
$('#databaseCloseRowBtn').addEventListener('click', () => rowModal.close());

function referenceLabel(options, value) {
  if (value == null) return '';
  return (
    options.find(o => String(o.value) === String(value))?.label || String(value)
  );
}
function humanize(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ==================== Start up ====================
// Tabs load their data the first time (and each time) they are opened
viewLoaders = {
  students: loadStudents,
  faculty: loadFaculty,
  database: showDatabase,
};
loadStats();
// Warm the course/branch lists in the background so the student form and table labels are ready
loadStudentMeta().catch(() => {});
showView(location.hash.slice(1));

// Handy for wiring the hooks from the browser console or another script
window.adminHooks = {
  renderActivity,
  renderAttendanceReport,
  setAttendanceLoader,
};
