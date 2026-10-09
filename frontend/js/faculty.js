import { getCurrentUser, logout } from '/utils/storage.js';
import postData from '/utils/fetch.js';
import { showToast } from './ui.js';

const $ = sel => document.querySelector(sel);
const currentUser = getCurrentUser() || {};
const facultyId = currentUser.username;
const baseTitle = document.title;
const defaultSubjectLabel =
  currentUser.subName || currentUser.subjectName || '';

// ---------- Small helpers ----------
const pad = n => String(n).padStart(2, '0');

// Today in the teacher's own time zone. toISOString() is UTC, so it would
// show yesterday early in the morning in India.
function localISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// One time format everywhere (QR, CCTV and manual all used different ones)
const formatTime = (d = new Date()) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
}

// "10:30", "10:30:00" or "10:30 AM" -> minutes since midnight (null if unreadable)
function toMinutes(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap]m)?$/i.exec(
    String(text || '').trim(),
  );
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2] || 0);
  const suffix = m[3]?.toLowerCase();
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

// The server sends short codes. Teachers should never see them.
const ERROR_TEXT = {
  no_timetable_entry: 'No class is scheduled for that slot on that date.',
  invalid_date: 'That date is not valid. Pick the date again.',
  faculty_not_found: 'Your faculty account could not be found. Sign in again.',
  subject_does_not_take_attendance:
    'This subject does not take attendance, so a session cannot be started.',
  date_outside_timetable: 'This class is not in the timetable on that date.',
  session_already_ended:
    'Attendance for this class was already submitted today.',
  session_method_mismatch:
    'A session for this class is already open with a different method.',
  database_error: 'The server had a problem. Please try again.',
  session_insert_failed: 'The session could not be created. Please try again.',
  invalid_session: 'This session no longer exists. Start a new one.',
  session_not_found: 'This session no longer exists. Start a new one.',
  session_ended: 'This session has already ended.',
  missing_session_code: 'This session is not active any more.',
  class_has_no_students: 'This class has no students enrolled.',
  camera_unreachable:
    'The classroom camera did not respond. Check that it is online and try again, or add students manually.',
  no_camera_configured:
    'No camera is set up for this classroom yet. Ask the admin to add it.',
  invalid_camera_url:
    "This classroom's camera address is not valid. Ask the admin to fix it.",
  cctv_processing_failed:
    'The CCTV image could not be processed. Try again, or add students manually.',
};
const friendlyError = code =>
  ERROR_TEXT[code] || 'Something went wrong. Please try again.';

// The roll number, if the server sent one
const idLabel = s => String(s.roll_number || s.rollNumber || '');

// Puts the roll number right beside the student's name (list rows, dialogs, absent list)
function setNameCell(el, name, roll) {
  const key = `${name}|${roll}`;
  if (el.dataset.key === key) return; // unchanged: leave the DOM alone
  el.dataset.key = key;
  const nodes = [document.createTextNode(name)];
  if (roll) {
    const rollEl = document.createElement('span');
    rollEl.className = 'roster-roll';
    rollEl.textContent = roll;
    nodes.push(rollEl);
  }
  el.replaceChildren(...nodes);
}
const byName = (a, b) => a.name.localeCompare(b.name);

// ---------- Page basics ----------
$('.user-name b').textContent = currentUser.name || 'Teacher';
$('#sub-name').textContent = defaultSubjectLabel;
$('.logout-btn').addEventListener('click', () => logout());

// Tabs: Session / History
document.querySelectorAll('.nav-item').forEach(tab => {
  tab.addEventListener('click', () => {
    document
      .querySelectorAll('.nav-item')
      .forEach(t => t.removeAttribute('aria-current'));
    tab.setAttribute('aria-current', 'page');
    document
      .querySelectorAll('.view')
      .forEach(v => (v.hidden = v.id !== `view-${tab.dataset.view}`));
    if (tab.dataset.view === 'history') renderHistory(loadHistory());
    // Land on the new heading so screen-reader users hear where they are
    document
      .querySelector(`#view-${tab.dataset.view} h1.section-title`)
      ?.focus({ preventScroll: true });
  });
});

// ---------- History ----------
// The server cannot list past sessions yet, so submitted sessions are kept in
// this browser. Swap loadHistory() for a fetch when an endpoint exists.
const HISTORY_KEY = `faculty-history:${facultyId}`;
const HISTORY_LIMIT = 50;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(entry) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([entry, ...loadHistory()].slice(0, HISTORY_LIMIT)),
    );
  } catch {
    // Storage full or blocked: history is a nicety, never block submitting
  }
}

// sessions: [{ date, slot, method, present, total, at }]
export function renderHistory(sessions) {
  $('#historyEmpty').hidden = sessions.length > 0;
  $('#historyList').replaceChildren(
    ...sessions.map(s => {
      const li = document.createElement('li');
      li.className = 'card list-row';

      const info = document.createElement('div');
      const title = document.createElement('span');
      title.className = 'roster-name';
      title.textContent = `${formatDate(s.date)} · ${s.slot}`;
      const meta = document.createElement('span');
      meta.className = 'roster-meta';
      meta.textContent = [s.method.toUpperCase(), s.at && `Submitted ${s.at}`]
        .filter(Boolean)
        .join(' · ');
      info.append(title, meta);

      const badge = document.createElement('span');
      badge.className = 'badge badge-success';
      badge.textContent = `${s.present}${s.total ? ` of ${s.total}` : ''} present`;
      li.append(info, badge);
      return li;
    }),
  );
}

// Errors during full screen would be hidden behind it, so leave full screen first
function notify(message, type = 'info') {
  if (type === 'error' && document.fullscreenElement) document.exitFullscreen();
  showToast(message, type);
}

// ---------- Elements and state ----------
const beforeStart = $('#beforeStart');
const afterStart = $('#afterStart');
const liveGrid = $('.live-grid');
const qrPanel = $('#qrPanel');
const qrCanvas = $('#qrCanvas');
const fullscreenBtn = $('#fullscreenBtn');
const connBanner = $('#connBanner');
const studentList = $('#studentList');
const startBtn = $('#startSessionBtn');
const dateInput = $('#date');
const slotList = $('#slots');
const manualDialog = $('#manual-attendance-dialog');
const submitDialog = $('#submit-dialog');
const cctvResultImage = $('#cctvResultImage');

let sessionCode = null;
let sessionMethod = null;
let sessionMeta = null; // { date, slot, method } saved to History on submit
let qrTimer = null;
let renderTimer = null;
let classIds = [];
let classInfo = []; // full class records for the selected slot (merged classes have several)
let headerInfo = null; // what the session header shows; fixed when the session starts
let slotRequestId = 0;
let classRequestId = 0;
let rosterQuery = '';

const slotInfo = new Map(); // slotId -> slot from the server
const allStudents = new Map(); // studentId -> { id, name, username, roll_number }
const roster = new Map(); // studentId -> { name, time, source: 'qr'|'cctv'|'manual', present }
const rowEls = new Map(); // studentId -> <li> currently in the list
const pendingVerify = new Map(); // studentId -> match score (or null) the camera was unsure about

const getMethod = () => $('input[name="method"]:checked').value;
const getSlotId = () => $('input[name="slot"]:checked')?.value;
const selectedSlot = () => slotInfo.get(String(getSlotId()));
const updateSubjectHeader = () => {
  $('#sub-name').textContent =
    selectedSlot()?.subject_label || defaultSubjectLabel;
};

// ---------- Setup: date, slots, classes ----------
dateInput.value ||= localISODate(); // today; teacher can change it

function updateDateWarning() {
  const today = localISODate();
  const warn = $('#dateWarn');
  const chosen = dateInput.value;
  warn.hidden = chosen === today;
  if (warn.hidden) return;
  const when = chosen < today ? 'in the past' : 'in the future';
  warn.textContent = `This date is ${when}. Attendance will be recorded for ${formatDate(chosen)}.`;
}

function updateStartLabel() {
  startBtn.textContent = `Start ${getMethod() === 'qr' ? 'QR' : 'CCTV'} session`;
}

// Pre-select the class happening now (or the next one) when taking today's attendance
function chooseSlot(slots) {
  if (dateInput.value !== localISODate()) return { pick: 0, nowId: null };
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const times = slots.map(s => ({
    start: toMinutes(s.start_time),
    end: toMinutes(s.end_time),
  }));
  const current = times.findIndex(
    t =>
      t.start !== null &&
      t.end !== null &&
      minutes >= t.start &&
      minutes < t.end,
  );
  if (current !== -1) return { pick: current, nowId: slots[current].id };
  const upcoming = times.findIndex(t => t.start !== null && t.start > minutes);
  return { pick: upcoming === -1 ? 0 : upcoming, nowId: null };
}

async function loadSlots() {
  const requestId = ++slotRequestId; // ignore answers that arrive late
  slotList.replaceChildren(
    ...[1, 2].map(() =>
      Object.assign(document.createElement('div'), {
        className: 'skeleton slot-skeleton',
      }),
    ),
  );
  $('#slotMsg').hidden = true;
  $('#slotEmpty').hidden = true;
  updateSubjectHeader();
  startBtn.disabled = true;
  updateDateWarning();

  try {
    const res = await fetch(
      `/api/session/slots?date=${encodeURIComponent(dateInput.value)}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    // Morning classes first, whatever order the database returns them in
    const slots = (await res.json()).sort(
      (a, b) => (toMinutes(a.start_time) ?? 0) - (toMinutes(b.start_time) ?? 0),
    );
    if (requestId !== slotRequestId) return;

    const { pick, nowId } = chooseSlot(slots);
    slotInfo.clear();
    slotList.replaceChildren(
      ...slots.map((slot, i) => {
        slotInfo.set(String(slot.id), slot);
        const label = document.createElement('label');
        label.className = 'slot-card';
        label.innerHTML =
          '<input type="radio" name="slot"><span class="slot-body"><span class="slot-time"></span><span class="slot-details"></span></span>';
        const input = label.querySelector('input');
        input.value = slot.id;
        input.checked = i === pick;
        input.addEventListener('change', () => {
          updateSubjectHeader();
          loadClasses();
        });
        const time = label.querySelector('.slot-time');
        time.textContent = `${slot.start_time} - ${slot.end_time}`;
        if (nowId !== null && String(slot.id) === String(nowId)) {
          const badge = document.createElement('span');
          badge.className = 'badge badge-success slot-badge';
          badge.textContent = 'Now';
          time.append(' ', badge);
        }
        label.querySelector('.slot-details').textContent =
          `${slot.subject_abbr} (${slot.block}-${slot.room_number})`;
        return label;
      }),
    );
    $('#slotEmpty').hidden = slots.length > 0;
    startBtn.disabled = slots.length === 0;
    await loadClasses();
  } catch {
    if (requestId !== slotRequestId) return;
    slotList.replaceChildren();
    $('#slotMsg').textContent =
      'Could not load your timetable. Check your connection and change the date to retry.';
    $('#slotMsg').hidden = false;
  }
}

async function loadClasses() {
  const requestId = ++classRequestId; // a slow answer for an old slot must not win
  classIds = []; // reset every time so old ids never pile up
  classInfo = [];
  updateSubjectHeader();
  if (!getSlotId()) return;

  try {
    const res = await fetch(
      `/api/session/classes?date=${encodeURIComponent(dateInput.value)}&slotId=${encodeURIComponent(getSlotId())}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    const classes = await res.json();
    if (requestId !== classRequestId) return;
    classInfo = classes;
    classes.forEach(item => {
      classIds.push(item.class_id);
    });
  } catch {
    if (requestId === classRequestId)
      notify('Could not load the classes for this slot.', 'error');
  }
}

dateInput.addEventListener('change', () => {
  if (!dateInput.value) dateInput.value = localISODate(); // cleared with the picker's "Clear"
  loadSlots();
});
document.querySelectorAll('input[name="method"]').forEach(r =>
  r.addEventListener('change', () => {
    updateStartLabel();
  }),
);

// ---------- Roster ----------
const presentCount = () => {
  let n = 0;
  for (const s of roster.values()) if (s.present) n++;
  return n;
};
const isPresent = id => roster.get(String(id))?.present === true;

// Returns true only when something actually changed
function markPresent(id, name, source, time = formatTime()) {
  id = String(id);
  const entry = roster.get(id);
  if (entry?.present) return false;
  if (entry)
    Object.assign(entry, { present: true, markedAbsent: false, source, time });
  else roster.set(id, { name, time, source, present: true });
  return true;
}

function markAbsent(id) {
  const entry = roster.get(String(id));
  if (!entry?.present) return false;
  entry.present = false;
  entry.markedAbsent = true; // stays in the Present list, shown with a red border
  return true;
}

function updateCounts() {
  const present = presentCount();
  const total = allStudents.size;
  $('#studentCount').textContent = present;
  $('#studentTotal').textContent = total ? ` / ${total}` : '';
  const shown = total ? `${present} / ${total}` : String(present);
  $('#fsCount').textContent = shown;
  // Handy when the tab is in the background behind the slides
  if (sessionCode) document.title = `(${shown}) ${baseTitle}`;
  renderSessionHeader();
}

// ---------- Session header: which class (or merged classes) this session is for ----------
const titleCase = text => (text ? text[0].toUpperCase() + text.slice(1) : '');

// "CSE · Sem 5 · Sec A". Reads whichever name fields the server sends for a class.
function classLabel(c) {
  const branch = c.branch_abbr || c.branchAbbr || c.branch || '';
  const sem = c.semester ?? c.sem ?? '';
  const section = c.section ?? '';
  const label = [
    branch,
    sem !== '' ? `Sem ${sem}` : '',
    section !== '' ? `Sec ${section}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const base = label || c.label || c.name || `Class ${c.class_id ?? ''}`.trim();
  return c.batch ? `${base} · ${c.batch}` : base;
}

// Present / total for one class. Needs students that say which class they belong to;
// otherwise falls back to a headcount from the class record, if the server sent one.
function classCounts(c, isIn = isPresent) {
  const id = String(c.class_id);
  const mine = [...allStudents.values()].filter(
    s => String(s.class_id ?? s.classId) === id,
  );
  if (mine.length)
    return { total: mine.length, present: mine.filter(s => isIn(s.id)).length };
  const total = c.student_count ?? c.students ?? c.total_students ?? null;
  return {
    total:
      Number.isFinite(Number(total)) && total !== null ? Number(total) : null,
    present: null,
  };
}

let headerKey = '';
function renderSessionHeader() {
  const header = $('#sessionHeader');
  if (!headerInfo) {
    header.hidden = true;
    return;
  }
  header.hidden = false;
  const { slot, classes, date, method, sessionType } = headerInfo;
  const merged = classes.length > 1;
  $('#shPresent').textContent = presentCount();
  $('#shTotal').textContent = allStudents.size ? ` / ${allStudents.size}` : '';

  const rows = classes.map(c => ({ name: classLabel(c), ...classCounts(c) }));
  const meta = [
    formatDate(date),
    slot ? `${slot.start_time} - ${slot.end_time}` : '',
    slot?.block && slot?.room_number
      ? `Room ${slot.block}-${slot.room_number}`
      : '',
    method === 'qr' ? 'QR session' : 'CCTV session',
    sessionType ? `${titleCase(sessionType)} class` : '',
  ].filter(Boolean);
  const key = JSON.stringify([meta, rows, merged, slot?.subject_label]);
  if (key === headerKey) return; // nothing new: leave the DOM alone
  headerKey = key;

  $('#shKind').textContent = merged
    ? `Merged class · ${classes.length} classes together`
    : 'Single class';
  header.dataset.merged = merged ? 'true' : 'false';
  $('#shSubject').textContent =
    slot?.subject_label || slot?.subject_abbr || defaultSubjectLabel || 'Class';
  $('#shMeta').replaceChildren(
    ...meta.map(text =>
      Object.assign(document.createElement('li'), { textContent: text }),
    ),
  );

  $('#shClassesWrap').hidden = rows.length === 0;
  $('#shClassesLabel').textContent = merged ? 'Merged classes' : 'Class';
  $('#shClasses').replaceChildren(
    ...rows.map(row => {
      const li = document.createElement('li');
      li.className = 'sh-class';
      const name = document.createElement('span');
      name.className = 'sh-class-name';
      name.textContent = row.name;
      li.append(name);
      if (row.total !== null) {
        const count = document.createElement('span');
        count.className = 'sh-class-count';
        count.textContent =
          row.present === null
            ? `${row.total} students`
            : `${row.present} / ${row.total}`;
        li.append(count);
      }
      return li;
    }),
  );
}

function buildRows() {
  const q = rosterQuery.trim().toLowerCase();
  // Only students who were marked present show here. Someone the teacher then
  // marks absent stays in the list (red border) so it is easy to undo.
  // Everyone else is only reachable through Add manually.
  const via = { qr: 'QR', cctv: 'CCTV', manual: 'Manual' };
  const rows = [...roster]
    .filter(([, s]) => s.present || s.markedAbsent)
    .map(([id, s]) => ({
      id,
      name: s.name,
      label: idLabel(allStudents.get(id) || {}),
      present: s.present,
      verify: s.present && pendingVerify.has(id),
      meta: !s.present
        ? 'Marked absent'
        : pendingVerify.has(id)
          ? 'CCTV · not sure, please verify'
          : [via[s.source], s.time].filter(Boolean).join(' · '),
    }));
  return q
    ? rows.filter(
        r =>
          r.name.toLowerCase().includes(q) || r.label.toLowerCase().includes(q),
      )
    : rows;
}

function createRow() {
  const li = document.createElement('li');
  li.className = 'roster-row';
  const info = document.createElement('div');
  info.className = 'roster-info';
  const name = document.createElement('span');
  name.className = 'roster-name';
  const meta = document.createElement('span');
  meta.className = 'roster-meta';
  info.append(name, meta);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-sm row-action';
  li.append(info, btn);
  return li;
}

function fillRow(li, row) {
  li.dataset.id = row.id;
  li.dataset.mode = row.present ? 'present' : 'absent';
  li.dataset.verify = row.verify ? 'true' : 'false';
  setNameCell(li.querySelector('.roster-name'), row.name, row.label);
  li.querySelector('.roster-meta').textContent = row.meta;
  const action = row.present ? 'Mark absent' : 'Mark present';
  const btn = li.querySelector('.row-action');
  btn.textContent = action;
  btn.setAttribute(
    'aria-label',
    `${action}: ${row.name}${row.label ? `, roll number ${row.label}` : ''}`,
  );
}

// While the teacher is aiming at a button, rows must not slide away from under it
const hoverCapable = matchMedia('(hover: hover)').matches;
let lastTouch = 0;
studentList.addEventListener('pointerdown', () => (lastTouch = Date.now()));
const listBusy = () =>
  hoverCapable ? studentList.matches(':hover') : Date.now() - lastTouch < 1500;

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderRoster(), 600);
}

// Updates the list in place. Rows are only created, edited or removed, never
// rebuilt, so buttons keep their position and keyboard focus while scans arrive.
function renderRoster({ force = false } = {}) {
  updateCounts();
  const rows = buildRows();
  const wanted = new Set(rows.map(r => r.id));
  const hasStale = [...rowEls.keys()].some(id => !wanted.has(id));
  const hold = hasStale && !force && listBusy();

  if (!hold) {
    for (const [id, li] of rowEls) {
      if (wanted.has(id)) continue;
      li.remove();
      rowEls.delete(id);
    }
  }

  rows.forEach((row, index) => {
    let li = rowEls.get(row.id);
    if (!li) rowEls.set(row.id, (li = createRow()));
    fillRow(li, row);
    if (hold) {
      if (!li.isConnected) studentList.appendChild(li);
    } else if (studentList.children[index] !== li) {
      studentList.insertBefore(li, studentList.children[index] || null);
    }
  });
  if (hold) scheduleRender();

  const empty = $('#rosterEmpty');
  empty.hidden = rows.length > 0;
  if (rows.length === 0) {
    const q = rosterQuery.trim();
    if (q) empty.textContent = `No students match "${q}".`;
    else
      empty.textContent =
        sessionMethod === 'cctv'
          ? 'Nobody was recognised. Use Add manually for anyone in class.'
          : 'Waiting for students to scan...';
  }
}

// Marks students present from the absent list or the dialog
async function addManually(students) {
  const response = await postData('/api/attendance/manual', {
    sessionCode,
    students,
  });
  if (!response?.ok) {
    notify(
      `Could not mark ${students.length === 1 ? students[0].name : 'those students'} present. ${friendlyError(response?.error)}`,
      'error',
    );
    return false;
  }
  const time = formatTime();
  students.forEach(s => markPresent(s.id, s.name, 'manual', time));
  renderRoster({ force: true });
  return true;
}

// One handler for every row's button
studentList.addEventListener('click', async event => {
  const btn = event.target.closest('.row-action');
  const li = btn?.closest('.roster-row');
  if (!li) return;
  const id = li.dataset.id;

  if (li.dataset.mode === 'present') {
    const index = [...studentList.children].indexOf(li);
    markAbsent(id);
    pendingVerify.delete(id);
    drawCctvVerify();
    renderRoster({ force: true });
    // The row is gone, so keep keyboard users in the same place in the list
    const buttons = studentList.querySelectorAll('.row-action');
    buttons[Math.min(index, buttons.length - 1)]?.focus();
    return;
  }
  btn.setAttribute('aria-busy', 'true');
  await addManually([{ id, name: allStudents.get(id)?.name || '' }]);
  btn.removeAttribute('aria-busy');
});

$('#rosterSearch').addEventListener('input', event => {
  rosterQuery = event.target.value;
  renderRoster({ force: true });
});

function addStudents(list) {
  list
    .map(s => ({ ...s, id: String(s.id) }))
    .sort(byName)
    .forEach(s => allStudents.set(s.id, s));
}

async function loadAllStudents() {
  const code = sessionCode;
  if (!code) return;
  try {
    const res = await fetch(`/api/students/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error();
    const list = await res.json();
    if (code !== sessionCode) return;
    addStudents(list);
    renderRoster();
  } catch {
    if (code === sessionCode)
      notify(
        'Could not load the class list, so absent students cannot be shown.',
        'error',
      );
  }
}

// Screen readers: batch scans into one calm announcement instead of one per student
let announced = 0;
let announceTimer;
function announcePresent(name) {
  announced++;
  const first = name;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    $('#srAnnounce').textContent =
      announced === 1
        ? `${first} marked present`
        : `${announced} students marked present`;
    announced = 0;
  }, 1000);
}

// ---------- Live updates ----------
// Students scanning their QR arrive through the socket
const socket = io(location.origin);
let socketWasDown = false;

socket.on('attendance_update', data => {
  if (String(data.sessionCode || data.sessionId) !== String(sessionCode))
    return;
  const source = data.method === 'manual' ? 'manual' : 'qr';
  if (!markPresent(data.studentId, data.studentName, source)) return;

  const nearBottom =
    studentList.scrollHeight -
      studentList.scrollTop -
      studentList.clientHeight <
    80;
  renderRoster();
  // Follow new arrivals only if the teacher has not scrolled up to read
  if (nearBottom) studentList.scrollTop = studentList.scrollHeight;
  announcePresent(data.studentName);
});

socket.on('disconnect', () => {
  socketWasDown = true;
  if (sessionCode) connBanner.hidden = false;
});
socket.on('connect_error', () => {
  if (sessionCode) connBanner.hidden = false;
});
socket.on('connect', () => {
  if (!sessionCode) return;
  // After a reconnect the server has forgotten which room we were in
  socket.emit('join_session', sessionCode);
  connBanner.hidden = true;
  if (socketWasDown) {
    socketWasDown = false;
    notify(
      'Live updates are back. Anyone who scanned while you were offline may be missing, so check the list.',
      'info',
    );
  }
});

// ---------- Start session ----------
startBtn.addEventListener('click', async () => {
  const slotId = getSlotId();
  if (!slotId) return notify('Pick a class slot first.', 'error');
  const method = getMethod();

  startBtn.setAttribute('aria-busy', 'true');
  startBtn.disabled = true;
  try {
    const response = await postData('/api/session/start', {
      date: dateInput.value,
      slotId,
      facultyId,
      method,
      classIds,
      sessionType: $('input[name="session-type"]:checked').value,
    });
    if (!response)
      return notify('Could not reach the server. Try again.', 'error');
    if (!response.ok)
      return notify(
        `Could not start the session. ${friendlyError(response.error)}`,
        'error',
      );

    sessionCode = response.sessionCode;
    sessionMethod = method;
    sessionMeta = {
      date: dateInput.value,
      slot: selectedSlot()?.label || 'Class',
      method,
    };
    headerInfo = {
      date: dateInput.value,
      slot: selectedSlot() ? { ...selectedSlot() } : null,
      classes: [...classInfo],
      method,
      sessionType: $('input[name="session-type"]:checked').value,
    };
    headerKey = '';
    roster.clear();
    pendingVerify.clear();
    allStudents.clear();
    rowEls.clear();
    studentList.replaceChildren();
    rosterQuery = '';
    $('#rosterSearch').value = '';
    socket.emit('join_session', sessionCode);

    beforeStart.hidden = true;
    afterStart.hidden = false;
    renderSessionHeader();
    const isQr = method === 'qr';
    qrCanvas.hidden = !isQr;
    $('#qrLive').hidden = !isQr;
    $('#cctvPanel').hidden = isQr;
    fullscreenBtn.hidden = !isQr || !document.fullscreenEnabled;
    $('#panelTitle').textContent = isQr
      ? 'Scan to mark attendance'
      : 'CCTV result';
    $('#panelTitle').focus({ preventScroll: true });
    $('#liveStatus').textContent = '';
    setQrLive(true);
    renderRoster({ force: true });
    loadAllStudents(); // runs alongside; the list fills in when it arrives
    if (isQr) renderQR(response);
    else await runCCTV();
  } catch {
    notify('Could not reach the server. Try again.', 'error');
  } finally {
    startBtn.removeAttribute('aria-busy');
    startBtn.disabled = false;
  }
});

// Closing the tab mid-class would lose the roster
window.addEventListener('beforeunload', event => {
  if (!sessionCode) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---------- QR code ----------
// Draw each new code off-screen and copy it over in one step, so the QR never blinks blank
const offscreen = document.createElement('canvas');
let qrLive = true;
let refreshFailures = 0;

function setQrLive(live, message) {
  if (qrLive === live && !message) return;
  qrLive = live;
  const el = $('#qrLive');
  el.dataset.state = live ? 'live' : 'stale';
  el.textContent =
    message ||
    (live ? 'QR refreshes automatically' : 'QR is not refreshing. Retrying...');
}

function renderQR(data) {
  if (!sessionCode) return;
  if (typeof QRCode === 'undefined') return ($('#qrError').hidden = false);
  // Draw at the screen's real pixel density so the code stays sharp when projected
  const size = Math.round(
    (qrCanvas.clientWidth || 320) * (window.devicePixelRatio || 1),
  );
  QRCode.toCanvas(offscreen, data.token, { width: size, margin: 1 }, err => {
    if (err || !sessionCode) return;
    // Changing a canvas's size clears it, so only do that when it really changed
    if (qrCanvas.width !== offscreen.width) {
      qrCanvas.width = offscreen.width;
      qrCanvas.height = offscreen.height;
    }
    qrCanvas.getContext('2d').drawImage(offscreen, 0, 0);
  });
  scheduleTokenRefresh(500); // the QR changes constantly so screenshots stop working
}

function scheduleTokenRefresh(delay) {
  clearTimeout(qrTimer);
  qrTimer = setTimeout(async () => {
    if (!sessionCode) return;
    // postData returns undefined when the network fails, so treat that as "not ok"
    const data = (await postData('/api/session/token', { sessionCode })) || {
      ok: false,
    };
    if (!sessionCode) return; // session ended while we waited

    if (data.ok) {
      refreshFailures = 0;
      setQrLive(true);
      return renderQR(data);
    }
    if (data.error === 'session_ended' || data.error === 'invalid_session') {
      setQrLive(false, 'Session ended. The QR has stopped.');
      return notify(friendlyError(data.error), 'error');
    }
    // Keep trying instead of freezing on an old QR, and say so after a couple of misses
    if (++refreshFailures >= 2) setQrLive(false);
    scheduleTokenRefresh(2000);
  }, delay);
}

// ---------- CCTV ----------
// How many faces the camera found in the picture. If the server reports it, use that.
// Without it the card still shows who was recognised, just not the number of faces seen.
function reportedFaces(response, recognised) {
  const sent = Number(
    response.facesDetected ?? response.faces_detected ?? response.detected,
  );
  return Number.isFinite(sent) && sent >= recognised ? sent : null;
}

// "28 faces seen · 8 recognised · 20 not recognised" beside the CCTV result title
function renderCctvSummary() {
  const summary = $('#cctvSummary');
  if (!cctvResult) {
    summary.hidden = true;
    return;
  }
  const recognised = cctvResult.recognisedIds.size;
  const { detected } = cctvResult;
  const chip = (className, count, text) => {
    const el = document.createElement('span');
    el.className = `badge ${className}`.trim();
    const num = document.createElement('b');
    num.textContent = count;
    el.append(num, ` ${text}`);
    return el;
  };
  const chips = [];
  if (detected !== null)
    chips.push(chip('', detected, detected === 1 ? 'face seen' : 'faces seen'));
  chips.push(chip('badge-success', recognised, 'recognised'));
  if (detected !== null)
    chips.push(chip('badge-warning', detected - recognised, 'not recognised'));
  summary.replaceChildren(...chips);
  summary.hidden = false;
}

// ---- "About this result": plain-language details under the CCTV picture ----
// A snapshot of what the camera found. Marking students by hand later does not change it.
// cctvResult: { time, recognisedIds, detected (null = unknown), width, height }
let cctvResult = null;

function drawCctvDetails() {
  const box = $('#cctvDetails');
  if (!cctvResult) {
    box.hidden = true;
    return;
  }
  const { time, recognisedIds } = cctvResult;
  const recognised = recognisedIds.size;
  const room = headerInfo?.slot;

  const facts = [];
  if (room?.block && room?.room_number)
    facts.push(['Camera', `Room ${room.block}-${room.room_number}`]);
  facts.push(['Checked at', time]);
  if (width && height)
    facts.push(['Picture size', `${width} × ${height} pixels`]);
  if (detected !== null) {
    facts.push([
      'Seen in the picture',
      `${detected} ${detected === 1 ? 'face' : 'faces'}`,
    ]);
    facts.push([
      'Recognised',
      `${recognised} of ${detected} faces matched to a student of this class`,
    ]);
  } else {
    facts.push([
      'Recognised',
      `${recognised} ${recognised === 1 ? 'student' : 'students'}`,
    ]);
  }
  const classes = headerInfo?.classes || [];
  if (classes.length > 1) {
    for (const c of classes) {
      const { present } = classCounts(c, id => recognisedIds.has(String(id)));
      if (present !== null)
        facts.push([
          classLabel(c),
          `${present} ${present === 1 ? 'student' : 'students'} recognised`,
        ]);
    }
  }

  $('#cctvFacts').replaceChildren(
    ...facts.map(([label, value]) => {
      const li = document.createElement('li');
      const l = Object.assign(document.createElement('span'), {
        className: 'cf-label',
        textContent: label,
      });
      const v = Object.assign(document.createElement('span'), {
        className: 'cf-value',
        textContent: value,
      });
      li.append(l, v);
      return li;
    }),
  );
  $('#cctvAdvice').textContent =
    recognised === 0
      ? 'No one could be recognised this time. Check that the camera view is clear and well lit, then try again, or mark students by hand.'
      : 'Students the camera missed are not marked present. Use Add manually for anyone who is in class.';
  box.hidden = false;
}

// Students the camera matched with low confidence (the orange "Name?" boxes).
// They are marked present for now; the teacher confirms or rejects each one.
// NOTE: reads whichever flag the server sends. Adjust here if the backend uses another name.
function uncertainFrom(response, presentIds) {
  const scoreOf = s => {
    const v = Number(s.score ?? s.similarity ?? s.confidence ?? s.match_score);
    return Number.isFinite(v) ? v : null;
  };
  const flagged = s =>
    s.uncertain === true ||
    s.needs_review === true ||
    s.needsReview === true ||
    s.low_confidence === true ||
    s.status === 'uncertain' ||
    s.match === 'uncertain';
  const out = new Map();
  for (const s of response.presentStudents || [])
    if (flagged(s)) out.set(String(s.student_id), scoreOf(s));
  const extra =
    response.uncertainStudents ??
    response.uncertain_students ??
    response.needsReview ??
    response.needs_review ??
    [];
  for (const s of extra) {
    const id = String(s.student_id ?? s.id);
    if (presentIds.has(id)) out.set(id, scoreOf(s));
  }
  return out;
}

function drawCctvVerify() {
  const box = $('#cctvVerify');
  const ids = [...pendingVerify.keys()].filter(id => isPresent(id));
  if (ids.length === 0) {
    box.hidden = true;
    $('#cctvVerifyList').replaceChildren();
    return;
  }
  $('#cctvVerifyTitle').textContent = `Please verify (${ids.length})`;
  $('#cctvVerifyNote').textContent =
    'The camera was not sure about these students (orange box). They are marked present for now. Check the picture, then confirm or reject each one.';
  $('#cctvVerifyList').replaceChildren(
    ...ids.map(id => {
      const student = allStudents.get(id) || {};
      const score = pendingVerify.get(id);
      const li = document.createElement('li');
      li.className = 'verify-row';
      li.dataset.id = id;
      const info = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'roster-name';
      setNameCell(
        name,
        student.name || roster.get(id)?.name || '',
        idLabel(student),
      );
      info.appendChild(name);
      if (score !== null) {
        const s = document.createElement('span');
        s.className = 'verify-score';
        s.textContent = `Match score ${score.toFixed(3)}`;
        info.appendChild(s);
      }
      const actions = document.createElement('div');
      actions.className = 'verify-actions';
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn btn-primary btn-sm';
      yes.dataset.verify = 'confirm';
      yes.textContent = 'Yes, present';
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'btn btn-secondary btn-sm';
      no.dataset.verify = 'reject';
      no.textContent = 'Not this student';
      actions.append(yes, no);
      li.append(info, actions);
      return li;
    }),
  );
  box.hidden = false;
}

$('#cctvVerifyList').addEventListener('click', event => {
  const btn = event.target.closest('button[data-verify]');
  const id = btn?.closest('.verify-row')?.dataset.id;
  if (!id) return;
  if (btn.dataset.verify === 'reject') markAbsent(id);
  pendingVerify.delete(id);
  drawCctvVerify();
  renderRoster({ force: true });
});

async function runCCTV() {
  const status = $('#liveStatus');
  $('#cctvDetails').hidden = true;
  $('#cctvVerify').hidden = true;
  pendingVerify.clear();
  cctvResult = null;
  $('#cctvError').hidden = true;
  $('#cctvSkeleton').hidden = false;
  cctvViewer.hidden = true;
  status.textContent = 'Processing CCTV footage...';

  $('#cctvSummary').hidden = true;
  $('#cctvRescan').hidden = true;

  // While the scan runs, tell the faculty if other classes are being scanned too.
  let scanning = true;
  const watchQueue = setInterval(async () => {
    try {
      const queue = await (await fetch('/api/attendance/cctv/queue')).json();
      if (!scanning || !sessionCode) return;
      const others = Math.max(0, (queue.activeScans || 0) - 1);
      status.textContent =
        others > 0
          ? `Processing CCTV footage... ${others} other ${others === 1 ? 'class is' : 'classes are'} being scanned too, so this may take a little longer.`
          : 'Processing CCTV footage...';
    } catch {
      // the hint is optional; never let it disturb the scan
    }
  }, 2000);
  let response;
  try {
    response = await postData('/api/attendance/cctv/run', { sessionCode });
  } finally {
    scanning = false;
    clearInterval(watchQueue);
  }
  if (!sessionCode) return; // session ended while we waited
  if (!response?.ok) {
    $('#cctvSkeleton').hidden = true;
    status.textContent = '';
    $('#cctvErrorText').textContent =
      `CCTV attendance failed. ${friendlyError(response?.error)}`;
    $('#cctvError').hidden = false;
    return;
  }

  // The camera's class list doubles as the absent list
  addStudents(response.students);

  // Only recognized CCTV students are marked present; everyone else is found through Add manually
  const presentIds = new Set(
    response.presentStudents.map(s => String(s.student_id)),
  );
  const time = formatTime();
  response.students
    .filter(s => presentIds.has(String(s.id)))
    .forEach(s => markPresent(s.id, s.name, 'cctv', time));
  uncertainFrom(response, presentIds).forEach((score, id) =>
    pendingVerify.set(id, score),
  );
  renderRoster({ force: true });
  const reported = reportedFaces(response, presentIds.size);
  cctvResult = {
    time,
    recognisedIds: presentIds,
    detected: reported, // null when the server does not say how many faces it found
  };
  renderCctvSummary();
  drawCctvDetails();
  drawCctvVerify();
  status.textContent = `${presentIds.size} ${presentIds.size === 1 ? 'student' : 'students'} recognised. Use Add manually for anyone the camera missed.`;

  cctvResultImage.onload = () => {
    $('#cctvSkeleton').hidden = true;
    cctvViewer.hidden = false;
    resetView(); // every new picture starts fitted
  };
  cctvResultImage.onerror = () => {
    $('#cctvSkeleton').hidden = true;
    notify('The annotated CCTV image could not be loaded.', 'error');
  };
  cctvResultImage.src = `/results/${sessionCode}.jpg?t=${Date.now()}`;
}

// "Try again" (after an error) and "Scan again" (after a result) run the same scan. Students already
// marked stay marked; a new scan only adds the ones the camera sees now (late arrivals).
for (const id of ['#cctvRetryBtn', '#cctvRescanBtn']) {
  $(id).addEventListener('click', async event => {
    const btn = event.currentTarget;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    await runCCTV();
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  });
}

// ---------- CCTV image zoom ----------
// Buttons, Ctrl + scroll or a pinch to zoom; drag to move; double-click to zoom in or fit.
const cctvViewer = $('#cctvViewer');
const cctvStage = $('#cctvStage');
const cctvFullscreenBtn = $('#cctvFullscreenBtn');
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.5;
const view = { scale: 1, x: 0, y: 0 }; // x, y: where the picture's top-left corner sits
const pointers = new Map(); // fingers (or the mouse button) currently down
let pinchStart = null;

function applyView() {
  const w = cctvStage.clientWidth;
  const h = cctvStage.clientHeight;
  view.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale));
  if (Math.abs(view.scale - 1) < 0.01) view.scale = 1; // no 100.00001% from rounding
  // Keep the picture covering its frame so no empty gaps show while moving around
  view.x = Math.min(0, Math.max(w - w * view.scale, view.x));
  view.y = Math.min(0, Math.max(h - h * view.scale, view.y));
  cctvResultImage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  cctvStage.classList.toggle('is-zoomed', view.scale > 1);
  $('#zoomLevel').textContent = `${Math.round(view.scale * 100)}%`;
  const limit = (id, atLimit) =>
    $(id).setAttribute('aria-disabled', String(atLimit));
  limit('#zoomOutBtn', view.scale <= ZOOM_MIN);
  limit('#zoomInBtn', view.scale >= ZOOM_MAX);
  limit('#zoomResetBtn', view.scale === ZOOM_MIN);
}

// Zoom around a point (the cursor, the pinch centre, or the middle) so it stays put
function zoomTo(
  next,
  cx = cctvStage.clientWidth / 2,
  cy = cctvStage.clientHeight / 2,
) {
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  const ratio = scale / view.scale;
  view.x = cx - (cx - view.x) * ratio;
  view.y = cy - (cy - view.y) * ratio;
  view.scale = scale;
  applyView();
}

function resetView() {
  Object.assign(view, { scale: 1, x: 0, y: 0 });
  applyView();
}

const stagePoint = event => {
  const rect = cctvStage.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
};

$('#zoomInBtn').addEventListener('click', () => zoomTo(view.scale * ZOOM_STEP));
$('#zoomOutBtn').addEventListener('click', () =>
  zoomTo(view.scale / ZOOM_STEP),
);
$('#zoomResetBtn').addEventListener('click', resetView);

cctvStage.addEventListener(
  'wheel',
  event => {
    // Plain scrolling must still scroll the page. Ctrl/Cmd + wheel (which is also
    // how a trackpad pinch arrives) zooms, and in full screen any wheel turn does.
    const fullscreen = document.fullscreenElement === cctvViewer;
    if (!event.ctrlKey && !event.metaKey && !fullscreen) return;
    event.preventDefault();
    const [x, y] = stagePoint(event);
    zoomTo(view.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), x, y);
  },
  { passive: false },
);

cctvStage.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  cctvStage.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: view.scale,
    };
  }
  if (view.scale > 1) cctvStage.classList.add('is-panning');
});

cctvStage.addEventListener('pointermove', event => {
  const p = pointers.get(event.pointerId);
  if (!p) return;
  const dx = event.clientX - p.x;
  const dy = event.clientY - p.y;
  p.x = event.clientX;
  p.y = event.clientY;

  if (pointers.size >= 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const rect = cctvStage.getBoundingClientRect();
    zoomTo(
      pinchStart.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist),
      (a.x + b.x) / 2 - rect.left,
      (a.y + b.y) / 2 - rect.top,
    );
  } else if (view.scale > 1) {
    view.x += dx;
    view.y += dy;
    applyView();
  }
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  pinchStart = null;
  if (pointers.size === 0) cctvStage.classList.remove('is-panning');
}
cctvStage.addEventListener('pointerup', endPointer);
cctvStage.addEventListener('pointercancel', endPointer);

cctvStage.addEventListener('dblclick', event => {
  if (view.scale > 1) return resetView();
  const [x, y] = stagePoint(event);
  zoomTo(2.5, x, y);
});

// Keyboard: + / - zoom, 0 fits, arrow keys move around once zoomed
cctvStage.addEventListener('keydown', event => {
  const move = 60;
  const zoomIn = () => zoomTo(view.scale * ZOOM_STEP);
  const zoomOut = () => zoomTo(view.scale / ZOOM_STEP);
  const pan = (dx, dy) => () => {
    view.x += dx;
    view.y += dy;
    applyView();
  };
  const actions = {
    '+': zoomIn,
    '=': zoomIn,
    '-': zoomOut,
    _: zoomOut,
    0: resetView,
    ArrowLeft: pan(move, 0),
    ArrowRight: pan(-move, 0),
    ArrowUp: pan(0, move),
    ArrowDown: pan(0, -move),
  };
  const action = actions[event.key];
  if (!action) return;
  if (event.key.startsWith('Arrow') && view.scale === 1) return; // let the page scroll
  event.preventDefault();
  action();
});

// Full screen for the image keeps the zoom controls on screen
cctvFullscreenBtn.hidden = !document.fullscreenEnabled;
cctvFullscreenBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === cctvViewer)
      await document.exitFullscreen();
    else await cctvViewer.requestFullscreen();
  } catch {
    notify('Could not open the CCTV image full screen.', 'error');
  }
});
window.addEventListener('resize', applyView);

// ---------- Full screen (for projectors) ----------
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else
    Promise.resolve(liveGrid.requestFullscreen?.()).catch(() =>
      notify('Full screen is not available on this device.', 'error'),
    );
});
document.addEventListener('fullscreenchange', () => {
  fullscreenBtn.textContent =
    document.fullscreenElement === liveGrid
      ? 'Exit full screen'
      : 'Full screen';
  cctvFullscreenBtn.textContent =
    document.fullscreenElement === cctvViewer
      ? 'Exit full screen'
      : 'Full screen';
  applyView(); // the picture's frame just changed size
});

// ---------- Add manually ----------
const manualSelected = new Set(); // ids ticked in the dialog
let manualQuery = '';
let manualShown = [];

$('#add-manually-btn').addEventListener('click', async () => {
  if (allStudents.size === 0) await loadAllStudents(); // it may have failed earlier
  if (allStudents.size === 0) return; // loadAllStudents already showed the error
  manualSelected.clear();
  manualQuery = '';
  $('#manualSearch').value = '';
  renderManualList();
  manualDialog.showModal();
});

function renderManualList() {
  const q = manualQuery.trim().toLowerCase();
  const pending = [...allStudents.values()].filter(s => !isPresent(s.id));
  const pendingIds = new Set(pending.map(s => s.id));
  for (const id of manualSelected)
    if (!pendingIds.has(id)) manualSelected.delete(id);

  manualShown = pending.filter(
    s =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      idLabel(s).toLowerCase().includes(q),
  );
  $('#manual-attendance-list').replaceChildren(
    ...manualShown.map(student => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = student.id;
      box.checked = manualSelected.has(student.id);
      const name = document.createElement('span');
      name.className = 'roster-name';
      setNameCell(name, student.name, idLabel(student));
      label.append(box, name);
      li.appendChild(label);
      return li;
    }),
  );
  const empty = $('#manualEmpty');
  empty.hidden = manualShown.length > 0;
  empty.textContent =
    pending.length === 0
      ? 'Everyone is already marked present.'
      : 'No students match your search.';
  updateManualControls();
}

function updateManualControls() {
  const ticked = manualShown.filter(s => manualSelected.has(s.id)).length;
  const all = $('#manualSelectAll');
  all.disabled = manualShown.length === 0;
  all.checked = manualShown.length > 0 && ticked === manualShown.length;
  all.indeterminate = ticked > 0 && ticked < manualShown.length;
  const n = manualSelected.size;
  const add = $('#add-selected-btn');
  add.textContent = n ? `Add selected (${n})` : 'Add selected';
  add.disabled = n === 0;
}

$('#manualSearch').addEventListener('input', event => {
  manualQuery = event.target.value;
  renderManualList();
});
$('#manualSelectAll').addEventListener('change', event => {
  manualShown.forEach(s =>
    event.target.checked
      ? manualSelected.add(s.id)
      : manualSelected.delete(s.id),
  );
  renderManualList();
});
$('#manual-attendance-list').addEventListener('change', event => {
  const box = event.target;
  if (box.type !== 'checkbox') return;
  if (box.checked) manualSelected.add(box.value);
  else manualSelected.delete(box.value);
  updateManualControls();
});

$('#closeDialog').addEventListener('click', () => manualDialog.close());

$('#add-selected-btn').addEventListener('click', async event => {
  // A scan may have marked someone present while the dialog was open
  const students = [...manualSelected]
    .filter(id => !isPresent(id))
    .map(id => ({ id, name: allStudents.get(id)?.name || '' }));
  if (students.length === 0) return;

  const btn = event.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  const ok = await addManually(students);
  btn.removeAttribute('aria-busy');
  if (!ok) return;
  manualDialog.close();
  showToast(
    `${students.length} student${students.length === 1 ? '' : 's'} marked present.`,
    'success',
  );
});

// ---------- Submit (asks first, because it ends the session) ----------
$('#submit-attendance-btn').addEventListener('click', () => {
  const present = presentCount();
  const total = allStudents.size;
  const absent = [...allStudents.values()].filter(s => !isPresent(s.id));

  $('#submitSummary').textContent = total
    ? `${present} of ${total} students will be marked present and ${absent.length} absent. This ends the session.`
    : `${present} student${present === 1 ? '' : 's'} will be marked present. This ends the session.`;

  const warn = $('#submitWarn');
  warn.hidden = present > 0;
  warn.textContent =
    'Nobody is marked present. Submitting now marks the whole class absent.';

  $('#submitAbsentList').replaceChildren(
    ...absent.map(s => {
      const li = document.createElement('li');
      setNameCell(li, s.name, idLabel(s));
      return li;
    }),
  );
  $('#submitAbsentBox').hidden = absent.length === 0;
  submitDialog.showModal();
});
$('#cancelSubmitBtn').addEventListener('click', () => submitDialog.close());

$('#confirmSubmitBtn').addEventListener('click', async event => {
  const btn = event.currentTarget;
  const presentStudentIds = [...roster]
    .filter(([, s]) => s.present)
    .map(([id]) => id);

  btn.setAttribute('aria-busy', 'true');
  const response = await postData('/api/session/finalize', {
    sessionCode,
    presentStudentIds,
  });
  btn.removeAttribute('aria-busy');
  submitDialog.close();

  if (!response?.ok)
    return notify(
      `Could not submit attendance. ${friendlyError(response?.error)} Nothing was lost; try again.`,
      'error',
    );

  const total = allStudents.size;
  saveHistory({
    ...sessionMeta,
    present: presentStudentIds.length,
    total,
    at: formatTime(),
  });
  renderHistory(loadHistory());
  showToast(
    `Attendance submitted: ${presentStudentIds.length}${total ? ` of ${total}` : ''} present.`,
    'success',
  );
  endSessionUI();
});

function endSessionUI() {
  clearTimeout(qrTimer);
  clearTimeout(renderTimer);
  sessionCode = null;
  sessionMethod = null;
  sessionMeta = null;
  headerInfo = null;
  renderSessionHeader();
  roster.clear();
  pendingVerify.clear();
  allStudents.clear();
  rowEls.clear();
  studentList.replaceChildren();
  rosterQuery = '';
  $('#rosterSearch').value = '';
  document.title = baseTitle;
  if (document.fullscreenElement) document.exitFullscreen();
  cctvViewer.hidden = true;
  $('#cctvSummary').hidden = true;
  cctvResult = null;
  $('#cctvDetails').hidden = true;
  cctvResultImage.removeAttribute('src');
  resetView();
  $('#cctvSkeleton').hidden = false;
  $('#cctvError').hidden = true;
  $('#qrError').hidden = true;
  connBanner.hidden = true;
  refreshFailures = 0;
  afterStart.hidden = true;
  beforeStart.hidden = false;
}

updateStartLabel();
renderHistory(loadHistory());
loadSlots();
