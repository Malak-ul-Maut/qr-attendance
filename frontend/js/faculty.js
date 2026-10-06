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

// Scans are stored with the server's own date format, so only trust the clock part
function timeFromStamp(stamp) {
  const m = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?)\s*$/i.exec(
    String(stamp || ''),
  );
  const minutes = m ? toMinutes(m[1]) : null;
  if (minutes === null) return '';
  const d = new Date();
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return formatTime(d);
}

// The server sends short codes. Teachers should never see them.
const ERROR_TEXT = {
  no_timetable_entry: 'No class is scheduled for that slot on that date.',
  database_error: 'The server had a problem. Please try again.',
  session_insert_failed: 'The session could not be created. Please try again.',
  invalid_session: 'This session no longer exists. Start a new one.',
  session_not_found: 'This session no longer exists. Start a new one.',
  session_ended: 'This session has already ended.',
  missing_session_code: 'This session is not active any more.',
  class_has_no_students: 'This class has no students enrolled.',
  cctv_processing_failed:
    'The CCTV image could not be processed. Try again, or add students manually.',
};
const friendlyError = code =>
  ERROR_TEXT[code] || 'Something went wrong. Please try again.';

// The roll number, if the server sent one
const idLabel = s => String(s.roll_number || s.rollNumber || '');

// Puts the roll number right beside the student's name in lists and dialogs
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
const resumeBox = $('#resumeBox');

let sessionCode = null;
let sessionMethod = null;
let sessionMeta = null; // { date, slot, method } saved to History on submit
let qrTimer = null;
let renderTimer = null;
let classIds = [];
let slotRequestId = 0;
let classRequestId = 0;
let rosterQuery = '';

const slotInfo = new Map(); // slotId -> slot from the server
const allStudents = new Map(); // studentId -> { id, name, username, roll_number }
const roster = new Map(); // studentId -> { name, time, source: 'qr'|'cctv'|'manual', present }
const rowEls = new Map(); // studentId -> <li> currently in the list

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
  updateSubjectHeader();
  if (!getSlotId()) return;

  try {
    const res = await fetch(
      `/api/session/classes?date=${encodeURIComponent(dateInput.value)}&slotId=${encodeURIComponent(getSlotId())}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    const classes = await res.json();
    if (requestId !== classRequestId) return;
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

// ---------- Saving and resuming ----------
// The roster is saved to the server as it changes. After a refresh, a closed tab
// or a crash, the teacher gets the same session back, QR and all.
const ACTIVE_KEY = `faculty-active-session:${facultyId}`;
const remember = code => {
  try {
    sessionStorage.setItem(ACTIVE_KEY, code);
  } catch {
    // Storage blocked: the Unfinished sessions list still finds it
  }
};
const forget = () => {
  try {
    sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    // nothing to clean up
  }
};
const remembered = () => {
  try {
    return sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
};

let draftTimer = null;
let draftVersion = 0; // bumps on every change, so a slow save never hides a newer one
let unsaved = false;

const draftBody = () => ({
  sessionCode,
  facultyId,
  method: sessionMethod,
  roster: Object.fromEntries(roster),
});

function saveDraftSoon() {
  if (!sessionCode) return;
  draftVersion++;
  unsaved = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 800);
}

async function saveDraft() {
  draftTimer = null;
  if (!sessionCode) return;
  const code = sessionCode;
  const version = draftVersion;
  const response = await postData('/api/session/draft', draftBody());
  if (code !== sessionCode) return;
  if (response?.ok) {
    if (version === draftVersion) unsaved = false;
    return;
  }
  if (response?.error === 'session_not_found') {
    unsaved = false; // finished or discarded somewhere else: nothing left to save
    return;
  }
  if (!draftTimer) draftTimer = setTimeout(saveDraft, 4000); // network hiccup: try again
}

// A refresh right after a change must not lose it: hand the last save to the browser
window.addEventListener('pagehide', () => {
  if (!sessionCode || !unsaved) return;
  try {
    navigator.sendBeacon(
      '/api/session/draft',
      new Blob([JSON.stringify(draftBody())], { type: 'application/json' }),
    );
  } catch {
    // best effort
  }
});

// Rebuild the roster after a reload. What the teacher last saw wins; scans the
// server recorded after that last save are added as present.
function restoreRoster({ roster: saved = {}, scans = [] }) {
  roster.clear();
  for (const [id, s] of Object.entries(saved)) {
    roster.set(String(id), {
      name: s.name,
      time: s.time || '',
      source: ['qr', 'cctv', 'manual'].includes(s.source) ? s.source : 'manual',
      present: s.present === true,
    });
  }
  for (const scan of scans) {
    const id = String(scan.id);
    if (roster.has(id)) continue;
    roster.set(id, {
      name: scan.name,
      time: timeFromStamp(scan.timestamp),
      source: 'qr',
      present: true,
    });
  }
}

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
  if (entry) Object.assign(entry, { present: true, source, time });
  else roster.set(id, { name, time, source, present: true });
  saveDraftSoon();
  return true;
}

function markAbsent(id) {
  const entry = roster.get(String(id));
  if (!entry?.present) return false;
  entry.present = false;
  saveDraftSoon();
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
}

function buildRows() {
  const q = rosterQuery.trim().toLowerCase();
  const via = { qr: 'QR', cctv: 'CCTV', manual: 'Manual' };
  const rows = [...roster].map(([id, student]) => ({
    id,
    name: student.name,
    label: idLabel(allStudents.get(id) || {}),
    present: student.present,
    meta: [student.present ? null : 'Absent', via[student.source], student.time]
      .filter(Boolean)
      .join(' · '),
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
      empty.textContent = allStudents.size
        ? 'No students have been marked yet.'
        : 'The class list is not available.';
  }
}

// Marks students present from the manual dialog
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

  if (isPresent(id)) {
    markAbsent(id);
  } else {
    const student = allStudents.get(id);
    if (!student) return;
    btn.disabled = true;
    const ok = await addManually([{ id, name: student.name }]);
    btn.disabled = false;
    if (!ok) return;
  }
  renderRoster({ force: true });
  rowEls.get(id)?.querySelector('.row-action')?.focus();
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
      'Live updates are back. Use Add manually for anyone who scanned while you were offline.',
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

    openSessionUI({
      code: response.sessionCode,
      method,
      meta: {
        date: dateInput.value,
        slot: selectedSlot()?.label || 'Class',
        method,
      },
    });
    renderRoster({ force: true });
    loadAllStudents(); // runs alongside; the list fills in when it arrives
    if (method === 'qr') renderQR(response);
    else await runCCTV();
  } catch {
    notify('Could not reach the server. Try again.', 'error');
  } finally {
    startBtn.removeAttribute('aria-busy');
    startBtn.disabled = false;
  }
});

// Switch the page into live mode. Shared by starting and by resuming a session.
function openSessionUI({ code, method, meta }) {
  sessionCode = code;
  sessionMethod = method;
  sessionMeta = meta;
  unsaved = false;
  roster.clear();
  allStudents.clear();
  rowEls.clear();
  studentList.replaceChildren();
  rosterQuery = '';
  $('#rosterSearch').value = '';
  remember(code);
  socket.emit('join_session', code);

  resumeBox.hidden = true;
  beforeStart.hidden = true;
  afterStart.hidden = false;
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
}

// A refresh is safe now, so only warn when a change has not reached the server yet
window.addEventListener('beforeunload', event => {
  if (!sessionCode || !unsaved) return;
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
async function runCCTV() {
  const status = $('#liveStatus');
  $('#cctvError').hidden = true;
  $('#cctvSkeleton').hidden = false;
  cctvViewer.hidden = true;
  status.textContent = 'Processing CCTV footage...';

  const response = await postData('/api/attendance/cctv/run', { sessionCode });
  if (!sessionCode) return; // session ended while we waited
  if (!response?.ok) {
    $('#cctvSkeleton').hidden = true;
    status.textContent = '';
    $('#cctvErrorText').textContent =
      `CCTV attendance failed. ${friendlyError(response?.error)}`;
    $('#cctvError').hidden = false;
    return;
  }

  // Keep missed students available through the Add manually dialog.
  addStudents(response.students);

  // Only recognized CCTV students are marked present.
  const presentIds = new Set(
    response.presentStudents.map(s => String(s.student_id)),
  );
  const time = formatTime();
  response.students
    .filter(s => presentIds.has(String(s.id)))
    .forEach(s => markPresent(s.id, s.name, 'cctv', time));
  renderRoster({ force: true });

  showCctvImage();
  status.textContent = `${presentCount()} of ${allStudents.size} recognised. Use Add manually for anyone the camera missed.`;
}

// Shows the annotated picture the recogniser saved for this session. After a
// resume a missing picture offers to run the recognition again.
function showCctvImage({ offerRetry = false } = {}) {
  $('#cctvError').hidden = true;
  $('#cctvSkeleton').hidden = false;
  cctvViewer.hidden = true;
  cctvResultImage.onload = () => {
    $('#cctvSkeleton').hidden = true;
    cctvViewer.hidden = false;
    resetView(); // every new picture starts fitted
  };
  cctvResultImage.onerror = () => {
    $('#cctvSkeleton').hidden = true;
    if (offerRetry) {
      $('#cctvErrorText').textContent =
        'The CCTV result picture could not be loaded. You can run the recognition again.';
      $('#cctvError').hidden = false;
    } else notify('The annotated CCTV image could not be loaded.', 'error');
  };
  cctvResultImage.src = `/results/${sessionCode}.jpg?t=${Date.now()}`;
}

$('#cctvRetryBtn').addEventListener('click', async event => {
  const btn = event.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  await runCCTV();
  btn.removeAttribute('aria-busy');
});

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
  clearTimeout(draftTimer);
  draftTimer = null;
  unsaved = false;
  forget();
  sessionCode = null;
  sessionMethod = null;
  sessionMeta = null;
  roster.clear();
  allStudents.clear();
  rowEls.clear();
  studentList.replaceChildren();
  rosterQuery = '';
  $('#rosterSearch').value = '';
  document.title = baseTitle;
  if (document.fullscreenElement) document.exitFullscreen();
  cctvViewer.hidden = true;
  cctvResultImage.removeAttribute('src');
  resetView();
  $('#cctvSkeleton').hidden = false;
  $('#cctvError').hidden = true;
  $('#qrError').hidden = true;
  connBanner.hidden = true;
  refreshFailures = 0;
  afterStart.hidden = true;
  beforeStart.hidden = false;
  refreshResumeList(); // anything else still unfinished shows up again
}

// ---------- Unfinished sessions (resume / discard / clean up) ----------
let unfinished = []; // from the server, newest first

// Worth showing: today's or later, or anything that already recorded scans.
// Older sessions with no scans are just leftovers from closed tabs.
const worthListing = s => s.date >= localISODate() || s.scanCount > 0;

function renderResumeList() {
  const shown = unfinished.filter(worthListing);
  const leftovers = unfinished.length - shown.length;
  const listed = shown.slice(0, 5);
  resumeBox.hidden = Boolean(sessionCode) || (!listed.length && !leftovers);

  $('#resumeTitle').textContent = !listed.length
    ? 'Old unfinished sessions'
    : listed.length > 1
      ? 'Unfinished sessions'
      : 'Unfinished session';
  $('#resumeIntro').hidden = !listed.length;

  $('#resumeList').replaceChildren(
    ...listed.map(s => {
      const li = document.createElement('li');
      li.className = 'resume-row';
      li.dataset.code = s.sessionCode;

      const info = document.createElement('div');
      info.className = 'roster-info';
      const title = document.createElement('span');
      title.className = 'roster-name';
      title.textContent = `${s.slotLabel} · ${formatDate(s.date)}`;
      const started = timeFromStamp(s.startedAt);
      const meta = document.createElement('span');
      meta.className = 'roster-meta';
      meta.textContent = [
        s.method.toUpperCase(),
        started && `Started ${started}`,
        s.scanCount > 0 && `${s.scanCount} scanned`,
      ]
        .filter(Boolean)
        .join(' · ');
      info.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'resume-actions';
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'btn btn-primary btn-sm resume-btn';
      resume.textContent = 'Resume';
      resume.setAttribute('aria-label', `Resume ${title.textContent}`);
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'btn btn-danger btn-sm discard-btn';
      discard.textContent = 'Discard';
      discard.setAttribute('aria-label', `Discard ${title.textContent}`);
      actions.append(resume, discard);

      li.append(info, actions);
      return li;
    }),
  );

  $('#resumeMore').hidden = shown.length <= listed.length;
  $('#resumeMore').textContent =
    `${shown.length - listed.length} older unfinished sessions are not shown.`;
  $('#resumeCleanup').hidden = leftovers === 0;
  $('#resumeCleanupText').textContent =
    `${leftovers} old unfinished session${leftovers === 1 ? '' : 's'} with no scans, left behind by closed tabs.`;
}

// Returns false when the server could not be reached
async function refreshResumeList() {
  try {
    const res = await fetch(
      `/api/session/active?faculty_id=${encodeURIComponent(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    unfinished = await res.json();
  } catch {
    return false;
  }
  renderResumeList();
  return true;
}

async function resumeSession(code, btn) {
  btn?.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(
      `/api/session/resume?sessionCode=${encodeURIComponent(code)}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      notify(
        `Could not resume the session. ${friendlyError(data?.error)}`,
        'error',
      );
      if (data?.error === 'session_not_found') refreshResumeList(); // finished or discarded elsewhere
      return false;
    }

    openSessionUI({
      code: data.sessionCode,
      method: data.method,
      meta: {
        date: data.date,
        slot: data.slotLabel || 'Class',
        method: data.method,
      },
    });
    restoreRoster(data);
    renderRoster({ force: true });
    loadAllStudents();
    if (data.method === 'qr')
      scheduleTokenRefresh(0); // the QR comes straight back
    else showCctvImage({ offerRetry: true });
    showToast('Session restored.', 'success');
    return true;
  } catch {
    notify('Could not reach the server. Try again.', 'error');
    return false;
  } finally {
    btn?.removeAttribute('aria-busy');
  }
}

$('#resumeList').addEventListener('click', event => {
  const btn = event.target.closest('button');
  const li = btn?.closest('.resume-row');
  if (!li) return;
  if (btn.classList.contains('resume-btn')) resumeSession(li.dataset.code, btn);
  else if (btn.classList.contains('discard-btn'))
    askDiscard(li.dataset.code, li.querySelector('.roster-name').textContent);
});

// Discard: used for a listed session and for the one on screen
const discardDialog = $('#discard-dialog');
let discardTarget = null;

function askDiscard(code, label) {
  discardTarget = { code, label };
  $('#discardSummary').textContent =
    `${label} will be deleted along with any scans recorded so far. Nothing will be saved to attendance. This cannot be undone.`;
  discardDialog.showModal();
}

$('#discardSessionBtn').addEventListener('click', () =>
  askDiscard(
    sessionCode,
    `${sessionMeta.slot} · ${formatDate(sessionMeta.date)}`,
  ),
);
$('#cancelDiscardBtn').addEventListener('click', () => discardDialog.close());

$('#confirmDiscardBtn').addEventListener('click', async event => {
  const btn = event.currentTarget;
  const { code } = discardTarget;
  btn.setAttribute('aria-busy', 'true');
  const response = await postData('/api/session/cancel', {
    sessionCode: code,
    facultyId,
  });
  btn.removeAttribute('aria-busy');
  discardDialog.close();

  // Already gone (finished or discarded elsewhere) counts as done
  if (!response?.ok && response?.error !== 'session_not_found')
    return notify(
      `Could not discard the session. ${friendlyError(response?.error)}`,
      'error',
    );
  showToast('Session discarded.', 'success');
  if (code === sessionCode) endSessionUI();
  else refreshResumeList();
});

$('#cleanupBtn').addEventListener('click', async event => {
  const btn = event.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  const response = await postData('/api/session/cleanup', {
    facultyId,
    before: localISODate(),
  });
  btn.removeAttribute('aria-busy');
  if (!response?.ok)
    return notify(
      `Could not clear them. ${friendlyError(response?.error)}`,
      'error',
    );
  showToast(
    `${response.removed} old session${response.removed === 1 ? '' : 's'} cleared.`,
    'success',
  );
  refreshResumeList();
});

// On load: after a refresh go straight back into the session; otherwise just list
// anything unfinished so the teacher can resume or discard it.
async function restoreOnLoad() {
  const wasInSession = remembered();
  if (wasInSession) {
    beforeStart.hidden = true;
    $('#resumeStatus').hidden = false;
  }
  const loaded = await refreshResumeList();
  $('#resumeStatus').hidden = true;

  const stillOpen =
    wasInSession && unfinished.some(s => s.sessionCode === wasInSession);
  if (stillOpen && (await resumeSession(wasInSession))) return;
  // Submitted or discarded somewhere else, so there is nothing to go back to
  if (loaded && wasInSession && !stillOpen) forget();
  beforeStart.hidden = false;
}

updateStartLabel();
renderHistory(loadHistory());
loadSlots();
restoreOnLoad();
