import { getCurrentUser } from '/utils/storage.js';
import { enableLightDismiss, enableLightDismissAll } from '/utils/dialog.js';
import { mountAccountMenu } from './account-menu.js';
import postData from '/utils/fetch.js';
import { showToast } from './ui.js';
import { fmtClock, fmtDayDate, fmtTime } from './format.js';

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
// Dates and times come from format.js, so they read the same on every device (DD/MM/YYYY, "10:42 am").
const formatTime = (d = new Date()) => fmtClock(d);
const formatDate = fmtDayDate;

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
  slot_taken: 'Another faculty already has this period for that class.',
  room_in_use: 'That room is in use at this time. Pick another room.',
  no_class_on_sunday: 'There are no classes on Sundays.',
  pick_classes: 'Pick at least one class.',
  pick_periods: 'Pick at least one period.',
  pick_subject: 'Pick a subject.',
  subject_not_yours: 'You can only take attendance for subjects you teach.',
  class_not_yours: 'You can only pick classes you teach.',
  borrow_partial:
    'That period is a combined lecture with other classes. Pick all of those classes too, or choose another period.',
  invalid_room: 'That room could not be found. Pick the room again.',
  invalid_class_or_room: 'A class or room you picked no longer exists. Reload and try again.',
  invalid_slot: 'That period could not be found. Reload and try again.',
  session_has_marks:
    'Some students are already marked present. Confirm to discard the session and remove their marks.',
  marks_changed:
    'More students were marked while you were deciding. Check the count and confirm again.',
  session_not_submitted: 'This session has not been submitted yet.',
  not_your_session: 'This session belongs to another faculty.',
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
  cctv_service_unavailable:
    'The face recognition service is not running. Ask the admin to start it, or add students manually.',
  cctv_processing_failed:
    'The CCTV image could not be processed. Try again, or add students manually.',
};
const friendlyError = (code, details = {}) => {
  if (code === 'slot_taken')
    return `${details.takenBy || 'Another faculty'} already has this period for that class.`;
  if (code === 'room_in_use')
    return `That room is in use by ${details.takenBy || 'another faculty'} at this time. Pick another room.`;
  return ERROR_TEXT[code] || 'Something went wrong. Please try again.';
};

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
mountAccountMenu($('#accountMenu'), { user: currentUser, role: 'faculty' });
// Add manually closes on an outside click, except once someone is ticked (then it only nudges, so a stray click
// cannot throw the choices away). manualSelected is declared further down; it is only read when someone clicks.
enableLightDismiss($('#manual-attendance-dialog'), { canDismiss: () => manualSelected.size === 0 });
enableLightDismissAll(); // dialogs say how they behave with data-modal (see utils/dialog.js)

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
    if (tab.dataset.view === 'history') loadHistory();
    // Land on the new heading so screen-reader users hear where they are
    document
      .querySelector(`#view-${tab.dataset.view} h1.section-title`)
      ?.focus({ preventScroll: true });
  });
});

// ---------- History ----------
// Submitted sessions come from the server (/api/session/history), so they follow the faculty to any device.
const HISTORY_PAGE = 30;
let historyItems = [];
let historyMore = false;
let historyBusy = false;
let historyLoaded = false;

const VIA = { qr: 'QR', cctv: 'CCTV', manual: 'Manual' };

// "CSE · Sem 5 · A", or "CSE-5A + CSE-5B" when classes were taken together
function classesText(classes) {
  if (!classes?.length) return '';
  return classes.length > 1 ? classes.map(compactClassLabel).join(' + ') : classLabel(classes[0]);
}

// What the server's session header says in words: room, periods and the time range
function sessionFacts(header) {
  const periods = header?.periods || [];
  const first = periods[0];
  const last = periods.at(-1);
  return {
    room: header?.block && header?.room_number ? `${header.block}-${header.room_number}` : '',
    time: first ? `${fmtTime(first.start_time)} – ${fmtTime(last.end_time)}` : '',
    periodText:
      periods.length > 1
        ? `${shortPeriod(first.label)}–${shortPeriod(last.label)}`
        : first
          ? shortPeriod(first.label)
          : '',
    count: periods.length,
  };
}

function renderHistory() {
  $('#historyEmpty').hidden = !(historyLoaded && historyItems.length === 0);
  $('#historyMoreBtn').hidden = !historyMore;
  $('#historyList').replaceChildren(
    ...historyItems.map(item => {
      const facts = sessionFacts(item.header);
      const li = document.createElement('li');
      li.className = 'card history-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-row';
      btn.dataset.code = item.sessionCode;

      const info = document.createElement('span');
      info.className = 'roster-info';
      const title = document.createElement('span');
      title.className = 'roster-name';
      title.textContent = `${formatDate(item.date)} · ${item.header?.subject_label || 'Class'}`;
      const meta = document.createElement('span');
      meta.className = 'roster-meta';
      meta.textContent = [
        classesText(item.header?.classes),
        facts.periodText,
        facts.time,
        VIA[item.method],
      ]
        .filter(Boolean)
        .join(' · ');
      info.append(title, meta);

      const badge = document.createElement('span');
      badge.className = 'badge badge-success';
      badge.textContent = `${item.present}${item.total ? ` of ${item.total}` : ''} present`;
      btn.append(info, badge);
      li.append(btn);
      return li;
    }),
  );
}

async function loadHistory({ more = false } = {}) {
  if (historyBusy) return;
  historyBusy = true;
  $('#historyError').hidden = true;
  $('#historyLoading').hidden = historyItems.length > 0;
  $('#view-history').setAttribute('aria-busy', 'true');
  try {
    const offset = more ? historyItems.length : 0;
    const res = await fetch(
      `/api/session/history?facultyId=${enc(facultyId)}&limit=${HISTORY_PAGE}&offset=${offset}`,
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const seen = new Set(more ? historyItems.map(i => i.sessionCode) : []);
    historyItems = [
      ...(more ? historyItems : []),
      ...data.sessions.filter(i => !seen.has(i.sessionCode)),
    ];
    historyMore = data.hasMore;
    historyLoaded = true;
  } catch {
    $('#historyError').hidden = false;
  } finally {
    historyBusy = false;
    $('#historyLoading').hidden = true;
    $('#view-history').removeAttribute('aria-busy');
    renderHistory();
  }
}
$('#historyRetryBtn').addEventListener('click', () => loadHistory({ more: historyItems.length > 0 && historyMore }));
$('#historyMoreBtn').addEventListener('click', () => loadHistory({ more: true }));

function studentGroup(title, students, showHow) {
  const wrap = document.createElement('section');
  const h = document.createElement('h3');
  h.className = 'hd-heading';
  h.textContent = `${title} (${students.length})`;
  const ul = document.createElement('ul');
  ul.className = 'hd-list';
  for (const s of students) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'hd-name';
    setNameCell(name, s.name, s.rollNumber || '');
    li.append(name);
    if (showHow && s.method) {
      const how = document.createElement('span');
      how.className = 'hd-how';
      how.textContent = [VIA[s.method], s.markedAt && fmtClock(s.markedAt)].filter(Boolean).join(' · ');
      li.append(how);
    }
    ul.append(li);
  }
  if (!students.length) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = showHow ? 'Nobody was marked present.' : 'Nobody was absent.';
    wrap.append(h, none);
  } else wrap.append(h, ul);
  return wrap;
}

const historyDialog = $('#history-dialog');
$('#hdClose').addEventListener('click', () => historyDialog.close());
$('#historyList').addEventListener('click', async event => {
  const btn = event.target.closest('.history-row');
  if (!btn) return;
  const item = historyItems.find(i => i.sessionCode === btn.dataset.code);
  const facts = sessionFacts(item?.header);
  $('#hdTitle').textContent = item?.header?.subject_label || 'Class';
  $('#hdMeta').textContent = [
    formatDate(item?.date),
    classesText(item?.header?.classes),
    facts.periodText,
    facts.time,
    facts.room,
  ]
    .filter(Boolean)
    .join(' · ');
  $('#hdSummary').textContent = 'Loading...';
  $('#hdBody').replaceChildren();
  historyDialog.showModal();
  try {
    const res = await fetch(`/api/session/history/${enc(btn.dataset.code)}?facultyId=${enc(facultyId)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const present = data.students.filter(s => s.present);
    const absent = data.students.filter(s => !s.present);
    $('#hdSummary').textContent =
      `${present.length} of ${data.students.length} present` +
      (data.endedAt ? ` · Submitted ${fmtClock(data.endedAt)}` : '');
    $('#hdBody').replaceChildren(
      studentGroup('Absent', absent, false),
      studentGroup('Present', present, true),
    );
  } catch {
    $('#hdSummary').textContent = 'Could not load this session. Close this and try again.';
  }
});

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
let qrTimer = null;
let renderTimer = null;
let classIds = [];
let classInfo = []; // full class records for the selected slot (merged classes have several)
let headerInfo = null; // what the session bar shows; fixed when the session opens: { date, srv (the server's header), classes, method, kinds }
let slotRequestId = 0;
let classRequestId = 0;
let rosterQuery = '';

const slotInfo = new Map(); // slotId -> slot from the server
const allStudents = new Map(); // studentId -> { id, name, username, roll_number }
const roster = new Map(); // studentId -> { name, time, source: 'qr'|'cctv'|'manual', present, removed }. Anyone ever marked present stays here, struck through if the teacher takes them off.
const rowEls = new Map(); // studentId -> <li> currently in the list

const getMethod = () => $('input[name="method"]:checked').value;
const getSlotId = () => $('input[name="slot"]:checked')?.value;
const selectedSlot = () => slotInfo.get(String(getSlotId()));
const sessionType = () => $('input[name="session-type"]:checked').value; // 'regular' | 'extra'
// "Pick a class" until something is chosen, then the subject's name.
const updateSubjectHeader = () => {
  const subject =
    sessionType() === 'extra'
      ? chosenArrClassIds().length && $('#arrSubject').selectedOptions[0]?.textContent
      : selectedSlot()?.subject_label;
  const title = $('#sub-name');
  title.textContent = subject || 'Pick a class';
  title.classList.toggle('is-placeholder', !subject);
};

// ---------- Setup: date, periods, classes ----------
dateInput.value ||= localISODate(); // today; the faculty can change it

function updateDateWarning() {
  const today = localISODate();
  const warn = $('#dateWarn');
  const chosen = dateInput.value;
  warn.hidden = chosen === today;
  if (warn.hidden) return;
  const when = chosen < today ? 'in the past' : 'in the future';
  warn.textContent = `This date is ${when}. Attendance will be recorded for ${formatDate(chosen)}.`;
}

// Pre-select the class happening now (or the next one) when taking today's attendance
function chooseSlot(slots) {
  const free = slots.map(slot => !slot.taken_by); // a period someone else took cannot be started
  const firstFree = free.indexOf(true);
  if (dateInput.value !== localISODate()) return { pick: firstFree, nowId: null };
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
  if (current !== -1)
    return { pick: free[current] ? current : firstFree, nowId: slots[current].id };
  const upcoming = times.findIndex(
    (t, i) => free[i] && t.start !== null && t.start > minutes,
  );
  return { pick: upcoming === -1 ? firstFree : upcoming, nowId: null };
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
  slotInfo.clear();
  updateSubjectHeader();
  setStartLoading();
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
        input.disabled = Boolean(slot.taken_by);
        label.dataset.status = slot.taken_by ? 'taken' : 'own';
        input.addEventListener('change', () => {
          updateSubjectHeader();
          updateStartState();
          loadClasses();
          loadRooms();
        });
        const time = label.querySelector('.slot-time');
        time.innerHTML = '<span class="t-start"></span><span class="t-end"></span>';
        time.querySelector('.t-start').textContent = fmtTime(slot.start_time);
        time.querySelector('.t-end').textContent = ` – ${fmtTime(slot.end_time)}`;
        label.title = timeRange(slot);
        if (nowId !== null && String(slot.id) === String(nowId)) {
          const badge = document.createElement('span');
          badge.className = 'badge badge-success slot-badge';
          badge.textContent = 'Now';
          label.append(badge);
        }
        label.querySelector('.slot-details').textContent = slot.taken_by
          ? `${slot.subject_abbr}: taken by ${slot.taken_by}`
          : `${slot.subject_abbr}${slot.block ? ` · ${slot.block}-${slot.room_number}` : ''}`;
        return label;
      }),
    );
    $('#slotEmpty').hidden = slots.length > 0;
    updateSubjectHeader();
    updateStartState();
    await Promise.all([loadClasses(), loadRooms()]);
  } catch {
    if (requestId !== slotRequestId) return;
    slotList.replaceChildren();
    slotInfo.clear();
    updateStartState();
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

// ---------- Room, Extra sessions and the start button ----------
const roomSelect = $('#roomSelect');
const roomInfo = new Map(); // roomId -> room from the server
let roomRequestId = 0;
let arrangedRequestId = 0;
let arrangedClasses = []; // classes this faculty teaches (Extra sessions)
let extraSlots = []; // periods the server described for the chosen classes

const enc = encodeURIComponent;
const roomName = room => `${room.block}-${room.number}`;
const shortPeriod = label => String(label ?? '').replace(/^Period\s*/i, 'P');
const timeRange = slot => `${fmtTime(slot.start_time)} – ${fmtTime(slot.end_time)}`;
const chosenArrClassIds = () =>
  [...document.querySelectorAll('#arrClasses input:checked')].map(i => Number(i.value));
const chosenArrSlotIds = () =>
  [...document.querySelectorAll('#arrSlots input:checked')].map(i => Number(i.value));
const setupSlotIds = () =>
  sessionType() === 'regular'
    ? getSlotId() ? [Number(getSlotId())] : []
    : chosenArrSlotIds();

// Why the Start button is off, in a few words ('' when it can start).
function startBlocker() {
  if (sessionType() === 'extra') {
    if (!chosenArrClassIds().length) return 'Pick a class';
    if (!$('#arrSubject').value) return 'Pick a subject';
    if (!chosenArrSlotIds().length) return 'Pick a period';
    return '';
  }
  if (!slotInfo.size) return 'No class on this date';
  return getSlotId() ? '' : 'Pick a period';
}

function updateStartState() {
  const why = startBlocker();
  startBtn.disabled = Boolean(why);
  $('#startReason').textContent = why;
}

function setStartLoading() {
  startBtn.disabled = true;
  $('#startReason').textContent = 'Loading…';
}

// The room the faculty most likely means: the timetable's room for the period, or the class's home room.
function defaultRoomId() {
  if (sessionType() === 'regular') return selectedSlot()?.room_id ?? null;
  const first = chosenArrClassIds()[0];
  return arrangedClasses.find(c => c.class_id === first)?.room_id ?? null;
}

async function loadRooms() {
  const requestId = ++roomRequestId;
  const slotIds = setupSlotIds();
  try {
    const res = await fetch(
      `/api/session/rooms?date=${enc(dateInput.value)}&slotId=${slotIds.join(',')}&faculty_id=${enc(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    const rooms = await res.json();
    if (requestId !== roomRequestId) return;
    const preferred = defaultRoomId();
    const kept = roomSelect.value;
    roomInfo.clear();
    roomSelect.replaceChildren(
      ...rooms.map(room => {
        roomInfo.set(String(room.id), room);
        const option = document.createElement('option');
        option.value = room.id;
        const notes = [];
        if (room.id === preferred)
          notes.push(sessionType() === 'regular' ? 'timetable room' : 'class room');
        if (room.type === 'lab') notes.push('lab');
        if (room.in_use_by) notes.push(`in use by ${room.in_use_by}`);
        else if (room.planned) notes.push(`planned: ${room.planned}`);
        if (!room.has_camera) notes.push('no camera');
        option.textContent = notes.length
          ? `${roomName(room)} (${notes.join(', ')})`
          : roomName(room);
        option.disabled = Boolean(room.in_use_by);
        return option;
      }),
    );
    // Keep what the faculty already chose while the period changes, if that room is still free
    const free = id => rooms.find(r => String(r.id) === String(id) && !r.in_use_by);
    const usable = (userPickedRoom && free(kept)) || free(preferred) || rooms.find(r => !r.in_use_by);
    if (usable) roomSelect.value = usable.id;
    updateRoomHint();
  } catch {
    if (requestId === roomRequestId) {
      roomSelect.replaceChildren();
      updateRoomHint();
    }
  }
}

// The chip reads "Room F-307 · change"; this also tells the faculty what a room choice means.
function updateRoomHint() {
  const hint = $('#roomHint');
  const room = roomInfo.get(String(roomSelect.value));
  $('#roomText').textContent = room ? `Room ${roomName(room)}` : 'Pick a room';
  hint.classList.remove('warn');
  hint.hidden = true;
  if (!room) return;
  if (getMethod() === 'cctv' && !room.has_camera) {
    hint.textContent =
      'This room has no camera, so CCTV cannot see your class. Pick a room with a camera, or use QR.';
    hint.classList.add('warn');
    hint.hidden = false;
  } else if (room.planned && String(room.id) !== String(defaultRoomId())) {
    hint.textContent = `The timetable plans ${room.planned} in this room at this time. Make sure it is free.`;
    hint.hidden = false;
  }
}
let userPickedRoom = false; // true once the faculty uses the chip; until then the period decides the room
roomSelect.addEventListener('change', () => {
  userPickedRoom = true;
  updateRoomHint();
});

function chipRow(value, text, small, name) {
  const label = document.createElement('label');
  label.className = 'pick-chip';
  label.innerHTML = '<input type="checkbox"><span></span>';
  const input = label.querySelector('input');
  input.value = value;
  input.name = name;
  label.querySelector('span').append(text);
  if (small) {
    const note = document.createElement('small');
    note.textContent = small;
    label.querySelector('span').append(note);
  }
  return label;
}

// Extra: the faculty's own classes and subjects, then the periods for the chosen classes.
async function loadArranged() {
  const requestId = ++arrangedRequestId;
  $('#arrMsg').hidden = true;
  updateDateWarning();
  setStartLoading();
  const keptClasses = new Set(chosenArrClassIds());
  const keptSubject = $('#arrSubject').value;
  try {
    const res = await fetch(
      `/api/session/arranged/options?date=${enc(dateInput.value)}&faculty_id=${enc(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (requestId !== arrangedRequestId) return;
    arrangedClasses = data.classes || [];
    if (data.closed) {
      $('#arrMsg').textContent = 'There are no classes on Sundays. Pick another date.';
      $('#arrMsg').hidden = false;
    } else if (!arrangedClasses.length) {
      // Without this the Extra form is just blank, and it looks broken
      $('#arrMsg').textContent = 'You have no classes in the timetable this term, so there is nothing to take extra. Ask the admin office to add your periods.';
      $('#arrMsg').hidden = false;
    }
    $('#arrClasses').replaceChildren(
      ...arrangedClasses.map(c => {
        const row = chipRow(c.class_id, compactClassLabel(c), c.room || '', 'arr-class');
        const input = row.querySelector('input');
        input.checked = keptClasses.has(c.class_id) || arrangedClasses.length === 1;
        input.addEventListener('change', () => {
          updateSubjectHeader();
          loadArrangedSlots();
        });
        return row;
      }),
    );
    $('#arrSubject').replaceChildren(
      ...(data.subjects || []).map(subject => {
        const option = document.createElement('option');
        option.value = subject.id;
        option.textContent = subject.name;
        return option;
      }),
    );
    if ([...$('#arrSubject').options].some(o => o.value === keptSubject))
      $('#arrSubject').value = keptSubject;
    updateSubjectHeader();
    await loadArrangedSlots();
  } catch {
    if (requestId !== arrangedRequestId) return;
    $('#arrMsg').textContent = 'Could not load your classes. Check your connection and change the date to retry.';
    $('#arrMsg').hidden = false;
  }
}

const STATE_WORD = { own: 'Yours', borrow: 'Borrow', mine: 'Resume', taken: 'Taken', blocked: 'Combined' };

// Explains the periods that are not plain "free": what picking a borrowed one means, and why some are greyed out.
function updateArrNote() {
  const picked = new Set(chosenArrSlotIds());
  const lines = [];
  for (const slot of extraSlots) {
    const name = shortPeriod(slot.label);
    if (picked.has(slot.id) && slot.status === 'borrow')
      lines.push(`${name}: ${slot.note}. They can no longer take attendance for it.`);
    else if (picked.has(slot.id) && slot.status === 'mine') lines.push(`${name} was already started. It will resume.`);
    else if (slot.status === 'taken' || slot.status === 'blocked') lines.push(`${name}: ${slot.note}.`);
  }
  $('#arrNote').textContent = lines.join('\n');
}

async function loadArrangedSlots() {
  const requestId = ++arrangedRequestId;
  const classIdsChosen = chosenArrClassIds();
  const keptSlots = new Set(chosenArrSlotIds());
  try {
    const res = await fetch(
      `/api/session/arranged/slots?date=${enc(dateInput.value)}&faculty_id=${enc(facultyId)}&classIds=${classIdsChosen.join(',')}`,
    );
    if (!res.ok) throw new Error();
    const slots = await res.json();
    if (requestId !== arrangedRequestId) return;
    extraSlots = slots;
    $('#arrSlots').replaceChildren(
      ...slots.map(slot => {
        const label = document.createElement('label');
        label.className = 'slot-card';
        label.dataset.status = slot.status;
        label.title = `${timeRange(slot)}${classIdsChosen.length ? `. ${slot.note}` : ''}`;
        label.innerHTML =
          '<input type="checkbox" name="arr-slot"><span class="slot-body"><span class="slot-time"></span><span class="slot-details"></span><span class="slot-state"></span></span>';
        const input = label.querySelector('input');
        input.value = slot.id;
        input.disabled = slot.status === 'taken' || slot.status === 'blocked' || classIdsChosen.length === 0;
        input.checked = keptSlots.has(slot.id) && !input.disabled;
        input.addEventListener('change', () => {
          updateStartState();
          updateArrNote();
          loadRooms();
        });
        label.querySelector('.slot-time').textContent = shortPeriod(slot.label);
        label.querySelector('.slot-details').textContent = fmtTime(slot.start_time);
        label.querySelector('.slot-state').textContent = STATE_WORD[slot.status] || '';
        return label;
      }),
    );
    if (classIdsChosen.length === 0) $('#arrNote').textContent = 'Pick a class first.';
    else updateArrNote();
    updateStartState();
    await loadRooms();
  } catch {
    if (requestId !== arrangedRequestId) return;
    $('#arrMsg').textContent = 'Could not load the periods. Try again.';
    $('#arrMsg').hidden = false;
  }
}
$('#arrSubject').addEventListener('change', () => {
  updateSubjectHeader();
  updateStartState();
});

function refreshSetup() {
  updateSubjectHeader();
  return sessionType() === 'extra' ? loadArranged() : loadSlots();
}

function applySessionType() {
  const extra = sessionType() === 'extra';
  $('#regularSetup').hidden = extra;
  $('#extraSetup').hidden = !extra;
  userPickedRoom = false;
  refreshSetup();
}
document
  .querySelectorAll('input[name="session-type"]')
  .forEach(r => r.addEventListener('change', applySessionType));

// ---------- Date chip ----------
function syncDateChip() {
  $('#dateText').textContent = formatDate(dateInput.value);
}
function dateChanged() {
  if (!dateInput.value) dateInput.value = localISODate(); // cleared with the picker's "Clear"
  syncDateChip();
  userPickedRoom = false;
  refreshSetup();
}
// Previous / next day, skipping Sundays (there are no classes)
function stepDate(delta) {
  const d = parseISODate(dateInput.value) || new Date();
  do d.setDate(d.getDate() + delta);
  while (d.getDay() === 0);
  dateInput.value = localISODate(d);
  dateChanged();
}
$('#datePrev').addEventListener('click', () => stepDate(-1));
$('#dateNext').addEventListener('click', () => stepDate(1));
$('#dateChip').addEventListener('click', () => {
  try {
    dateInput.showPicker();
  } catch {
    dateInput.focus();
    dateInput.click();
  }
});
dateInput.addEventListener('change', dateChanged);
document.querySelectorAll('input[name="method"]').forEach(r => r.addEventListener('change', updateRoomHint));

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
  // Taken off the list by the teacher: a later scan or QR must not quietly put them back (only "Mark present" does)
  if (entry?.removed && source !== 'manual') return false;
  if (entry) Object.assign(entry, { present: true, removed: false, source, time });
  else roster.set(id, { name, time, source, present: true });
  return true;
}

function markAbsent(id) {
  const entry = roster.get(String(id));
  if (!entry?.present) return false;
  entry.present = false;
  entry.removed = true;
  return true;
}

function updateCounts() {
  const present = presentCount();
  const total = allStudents.size;
  const shown = total ? `${present} / ${total}` : String(present);
  $('#fsCount').textContent = shown;
  // Handy when the tab is in the background behind the slides
  if (sessionCode) document.title = `(${shown}) ${baseTitle}`;
  renderSessionHeader();
}

// ---------- Session bar: which class (or merged classes) this session is for ----------
// "CSE · Sem 5 · A" (and the batch, for a lab group). Reads whichever name fields the server sends for a class.
function classLabel(c) {
  const branch = c.branch_abbr || c.branchAbbr || c.branch || '';
  const sem = c.semester ?? c.sem ?? '';
  const section = c.section ?? '';
  const label = [branch, sem !== '' ? `Sem ${sem}` : '', section !== '' ? section : '']
    .filter(Boolean)
    .join(' · ');
  const base = label || c.label || c.name || `Class ${c.class_id ?? ''}`.trim();
  return c.batch ? `${base} · ${c.batch}` : base;
}

function compactClassLabel(c) {
  const branch = c.branch_abbr || c.branchAbbr || c.branch || '';
  const sem = c.semester ?? c.sem ?? '';
  const section = c.section ?? '';
  return branch && sem !== ''
    ? `${branch}-${sem}${section}`
    : classLabel(c);
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
// The live chip in the top bar: subject, classes and the running count, so it shows on every tab.
// Tapping it opens the Session tab. It is not a live region: the count changes too often to announce.
function updateHeaderStatus() {
  const chip = $('#headerStatus');
  if (!headerInfo) {
    chip.hidden = true;
    return;
  }
  const { classes } = headerInfo;
  const what = classes.map(compactClassLabel).filter(Boolean).join(' + ');
  const count = `${presentCount()}${allStudents.size ? ` / ${allStudents.size}` : ''}`;
  $('#headerStatusWhat').textContent = what;
  $('#headerStatusCount').textContent = count;
  chip.setAttribute('aria-label', `Live session: ${what}. ${count.replace(' / ', ' of ')} present. Open the session.`);
  chip.hidden = false;
}
$('#headerStatus').addEventListener('click', () => document.querySelector('.nav-item[data-view="session"]').click());

function renderSessionHeader() {
  const bar = $('#sessionHeader');
  updateHeaderStatus();
  if (!headerInfo) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const { srv, classes, date, kinds } = headerInfo;
  const merged = classes.length > 1;
  $('#shPresent').textContent = presentCount();
  $('#shTotal').textContent = allStudents.size ? `/${allStudents.size}` : '';

  const facts = sessionFacts(srv);
  const tags = [
    kinds.includes('arranged') ? 'Extra' : '',
    kinds.includes('borrowed') ? 'Borrowed' : '',
    facts.count > 1 ? `Double · ${facts.periodText}` : '',
  ].filter(Boolean);
  const meta = [
    date !== localISODate() ? formatDate(date) : '',
    merged ? '' : classes[0] ? classLabel(classes[0]) : '',
    facts.room,
    facts.time,
  ].filter(Boolean);
  const rows = merged ? classes.map(c => ({ name: compactClassLabel(c), ...classCounts(c) })) : [];
  const subject = srv?.subject_label || srv?.subject_abbr || defaultSubjectLabel || 'Class';
  const key = JSON.stringify([subject, tags, meta, rows]);
  if (key === headerKey) return; // nothing new: leave the DOM alone
  headerKey = key;

  bar.dataset.merged = merged ? 'true' : 'false';
  $('#shSubject').textContent = subject;
  $('#shTags').replaceChildren(
    ...tags.map(text => Object.assign(document.createElement('li'), { textContent: text })),
  );
  $('#shMeta').textContent = meta.join(' · ');
  $('#shClasses').hidden = rows.length === 0;
  $('#shClasses').replaceChildren(
    ...rows.map(row => {
      const li = document.createElement('li');
      li.className = 'sb-chip';
      const name = document.createElement('span');
      name.className = 'sb-chip-name';
      name.textContent = row.name;
      li.append(name);
      if (row.total !== null) {
        const count = document.createElement('span');
        count.className = 'sb-chip-count';
        count.textContent = row.present === null ? `${row.total}` : `${row.present}/${row.total}`;
        li.append(count);
      }
      return li;
    }),
  );
}

// One list: everyone marked present in this session. A student the teacher takes off stays in place, struck through,
// with an Undo button. Students who were never marked are found through "Add manually".
function buildRows() {
  const q = rosterQuery.trim().toLowerCase();
  const via = { qr: 'QR', cctv: 'CCTV', manual: 'Manual' };
  const rows = [...roster].map(([id, s]) => ({
    id,
    name: s.name,
    label: idLabel(allStudents.get(id) || {}),
    present: s.present,
    meta: s.present
      ? [idLabel(allStudents.get(id) || {}), via[s.source], s.time].filter(Boolean).join(' · ')
      : ['Marked absent', idLabel(allStudents.get(id) || {})].filter(Boolean).join(' · '),
  }));
  return q
    ? rows.filter(
        r =>
          r.name.toLowerCase().includes(q) || r.label.toLowerCase().includes(q),
      )
    : rows;
}

const ICON_REMOVE =
  '<svg class="ic-remove" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_UNDO =
  '<svg class="ic-undo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h8.5a5 5 0 0 1 0 10H11"/></svg>';

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
  btn.className = 'row-action';
  btn.innerHTML = ICON_REMOVE + ICON_UNDO;
  li.append(info, btn);
  return li;
}

function fillRow(li, row) {
  li.dataset.id = row.id;
  li.dataset.mode = row.present ? 'present' : 'absent';
  li.querySelector('.roster-name').textContent = row.name;
  li.querySelector('.roster-meta').textContent = row.meta;
  const action = row.present ? 'Mark absent' : 'Undo';
  const btn = li.querySelector('.row-action');
  btn.title = action;
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
          ? 'Nobody was recognised. Use Add manually for anyone who is in class.'
          : 'Waiting for students to scan...';
  }
}

// Marks students present from the Add manually dialog
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
    markAbsent(id); // the row stays where it is, struck through
  } else {
    const entry = roster.get(id); // Undo: back to how it was, no server call (Submit sends the final list)
    if (entry) Object.assign(entry, { present: true, removed: false });
  }
  saveRemoved();
  renderRoster({ force: true });
  studentList.querySelector(`[data-id="${CSS.escape(id)}"] .row-action`)?.focus();
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
// Students scanning their QR arrive through the socket. If the library did not load, or the connection drops, the
// list is re-read from the server every few seconds instead, so nobody goes missing.
const socket = typeof io === 'function' ? io(window.API_BASE || location.origin) : null;
const onSocket = (event, handler) => socket?.on(event, handler);
let socketWasDown = false;
const POLL_MS = 8000;

// Adds students the server has marked that this page does not know yet. Anyone already in the list, present or
// taken off by the teacher, is left exactly as the teacher has it.
function mergeServerMarks(marks) {
  let added = 0;
  for (const m of marks) {
    const id = String(m.id);
    if (roster.has(id)) continue;
    const source = m.method === 'cctv' ? 'cctv' : m.method === 'manual' ? 'manual' : 'qr';
    roster.set(id, { name: m.name, time: m.markedAt ? fmtClock(m.markedAt) : formatTime(), source, present: true });
    added++;
  }
  return added;
}

// true: list is up to date. false: could not tell. The session being gone elsewhere ends it here too.
async function syncMarks() {
  const code = sessionCode;
  if (!code) return false;
  try {
    const res = await fetch(`/api/session/active?facultyId=${enc(facultyId)}&code=${enc(code)}`);
    const data = await res.json();
    if (code !== sessionCode || !data.ok) return false;
    if (!data.active) {
      notify('This session was submitted or discarded somewhere else.', 'info');
      endSessionUI();
      return false;
    }
    if (mergeServerMarks(data.active.marks)) renderRoster();
    return true;
  } catch {
    return false;
  }
}

setInterval(() => {
  if (sessionCode && (!socket || !socket.connected)) syncMarks();
}, POLL_MS);

onSocket('attendance_update', data => {
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
  if (nearBottom)
    studentList.scrollTop = studentList.scrollHeight;
  announcePresent(data.studentName);
});

onSocket('disconnect', () => {
  socketWasDown = true;
  if (sessionCode) connBanner.hidden = false;
});
onSocket('connect_error', () => {
  if (sessionCode) connBanner.hidden = false;
});
onSocket('connect', async () => {
  if (!sessionCode) return;
  // After a reconnect the server has forgotten which room we were in
  socket.emit('join_session', sessionCode);
  connBanner.hidden = true;
  if (socketWasDown) {
    socketWasDown = false;
    const upToDate = await syncMarks();
    if (sessionCode)
      notify(
        upToDate
          ? 'Live updates are back. The list is up to date.'
          : 'Live updates are back. Anyone who scanned while you were offline may be missing, so use Add manually for anyone who is missing.',
        upToDate ? 'success' : 'info',
      );
  }
});

// ---------- Which students were taken off the list ----------
// "Taken off" lives only in this page until Submit. It is kept in the browser, so a refresh does not bring them back.
const removedKey = code => `faculty-removed:${code}`;
function saveRemoved() {
  if (!sessionCode) return;
  const ids = [...roster].filter(([, s]) => s.removed).map(([id]) => id);
  try {
    if (ids.length) localStorage.setItem(removedKey(sessionCode), JSON.stringify(ids));
    else localStorage.removeItem(removedKey(sessionCode));
  } catch {
    // storage blocked: the list still works, a refresh just forgets who was taken off
  }
}
function loadRemoved(code) {
  try {
    return JSON.parse(localStorage.getItem(removedKey(code))) || [];
  } catch {
    return [];
  }
}
function forgetRemoved(code) {
  try {
    localStorage.removeItem(removedKey(code));
  } catch {
    // nothing to do
  }
}

// ---------- Open the live view (a session just started, or one that is already running) ----------
function fallbackHeader() {
  const slot = selectedSlot();
  return {
    subject_label: slot?.subject_label,
    subject_abbr: slot?.subject_abbr,
    block: slot?.block,
    room_number: slot?.room_number,
    periods: slot ? [{ label: slot.label, start_time: slot.start_time, end_time: slot.end_time }] : [],
    kinds: [],
    classes: [...classInfo],
  };
}

function openLive({ code, method, date, header, marks = [], token = null, resumed = false }) {
  sessionCode = code;
  sessionMethod = method;
  const srv = header || fallbackHeader();
  headerInfo = { date, srv, classes: srv.classes || [], method, kinds: srv.kinds || [] };
  headerKey = '';
  roster.clear();
  allStudents.clear();
  rowEls.clear();
  studentList.replaceChildren();
  rosterQuery = '';
  $('#rosterSearch').value = '';
  mergeServerMarks(marks);
  for (const id of loadRemoved(code)) {
    const entry = roster.get(String(id));
    if (entry) Object.assign(entry, { present: false, removed: true });
  }
  socket?.emit('join_session', code);

  beforeStart.hidden = true;
  afterStart.hidden = false;
  renderSessionHeader();
  const isQr = method === 'qr';
  qrStage.hidden = !isQr;
  $('#qrLive').hidden = true;
  $('#cctvPanel').hidden = isQr;
  fullscreenBtn.hidden = !isQr || !document.fullscreenEnabled;
  $('#panelTitle').textContent = isQr ? 'Scan to mark attendance' : 'CCTV result';
  $('#panelTitle').focus({ preventScroll: true });
  $('#liveStatus').textContent = '';
  connBanner.textContent = socket
    ? 'Live updates paused. Reconnecting; the list still refreshes every few seconds.'
    : 'Live updates are not available on this page. The list refreshes every few seconds.';
  connBanner.hidden = Boolean(socket);
  setQrLive(true);
  renderRoster({ force: true });
  loadAllStudents(); // runs alongside; the list fills in when it arrives
  if (isQr) renderQR({ token });
  else if (resumed) showCctvAfterResume();
}

// A CCTV session that was already running: the scan is not repeated on its own. Show the last picture if the
// server still has it, and leave "Scan again" for the teacher.
function showCctvAfterResume() {
  $('#cctvSkeleton').hidden = true;
  $('#cctvRescan').hidden = false;
  cctvResultImage.onload = () => {
    cctvViewer.hidden = false;
    resetView();
  };
  cctvResultImage.onerror = () => {};
  cctvResultImage.src = window.apiUrl(`/results/${sessionCode}.jpg?t=${Date.now()}`);
}

// ---------- Start session ----------
startBtn.addEventListener('click', async () => {
  const extra = sessionType() === 'extra';
  const slotId = getSlotId();
  const blocker = startBlocker();
  if (blocker) return notify(`${blocker} first.`, 'error');
  const method = getMethod();
  const roomId = roomSelect.value ? Number(roomSelect.value) : undefined;

  startBtn.setAttribute('aria-busy', 'true');
  startBtn.disabled = true;
  try {
    const response = extra
      ? await postData('/api/session/arranged', {
          date: dateInput.value,
          facultyId,
          method,
          roomId,
          classIds: chosenArrClassIds(),
          slotIds: chosenArrSlotIds(),
          subjectId: Number($('#arrSubject').value),
        })
      : await postData('/api/session/start', {
          date: dateInput.value,
          slotId,
          facultyId,
          method,
          roomId,
          classIds,
          sessionType: sessionType(),
        });
    if (!response)
      return notify('Could not reach the server. Try again.', 'error');
    if (!response.ok)
      return notify(
        `Could not start the session. ${friendlyError(response.error, response)}`,
        'error',
      );

    openLive({
      code: response.sessionCode,
      method,
      date: dateInput.value,
      header: response.header,
      token: response.token,
    });
    if (method === 'cctv') await runCCTV();
  } catch {
    notify('Could not reach the server. Try again.', 'error');
  } finally {
    startBtn.removeAttribute('aria-busy');
    updateStartState();
  }
});

// After a refresh (or on another device): pick the faculty's running session up again.
async function resumeIfOpen() {
  try {
    const res = await fetch(`/api/session/active?facultyId=${enc(facultyId)}`);
    const data = await res.json();
    if (sessionCode || !data.ok || !data.active) return; // nothing running, or the faculty already started one
    const a = data.active;
    openLive({
      code: a.sessionCode,
      method: a.method,
      date: a.date,
      header: a.header,
      marks: a.marks,
      token: a.token,
      resumed: true,
    });
    showToast('Your running session is open again.', 'info');
  } catch {
    // The setup screen is already showing; a failed check just means nothing to resume
  }
}

// Closing the tab mid-class would lose the roster
window.addEventListener('beforeunload', event => {
  if (!sessionCode) return;
  event.preventDefault();
  event.returnValue = '';
});

// ---------- QR code ----------
// Draw each new code off-screen and copy it over in one step, so the QR never blinks blank
const qrStage = $('#qrStage');
const offscreen = document.createElement('canvas');
let qrLive = true;
let refreshFailures = 0;
let lastToken = null;
let qrSpan = 0; // squares across, margin included. Same for every token of the same length.
let qrSpanFor = 0;

// The stop-refreshing warning is the only QR status line: nothing is shown while all is well.
function setQrLive(live, message) {
  qrLive = live;
  const el = $('#qrLive');
  el.hidden = live && !message;
  el.dataset.state = live ? 'live' : 'stale';
  el.textContent = message || (live ? '' : 'QR is not refreshing. Retrying...');
}

// Draws at the screen's real pixel density with a whole number of pixels per square, so the code is sharp and
// evenly spaced at any window size (and when projected). The canvas is then shown at exactly that size.
function drawQR(token) {
  if (!sessionCode || !token) return;
  if (typeof QRCode === 'undefined') return ($('#qrError').hidden = false);
  const dpr = window.devicePixelRatio || 1;
  const box = Math.floor(Math.min(qrStage.clientWidth, qrStage.clientHeight)) || 320;
  const target = Math.max(160, Math.round(box * dpr));
  const paint = () => {
    const scale = Math.max(2, Math.floor(target / qrSpan));
    QRCode.toCanvas(offscreen, token, { scale, margin: 1 }, err => {
      if (err || !sessionCode) return;
      // Changing a canvas's size clears it, so only do that when it really changed
      if (qrCanvas.width !== offscreen.width || qrCanvas.height !== offscreen.height) {
        qrCanvas.width = offscreen.width;
        qrCanvas.height = offscreen.height;
      }
      qrCanvas.style.width = `${offscreen.width / dpr}px`;
      qrCanvas.style.height = `${offscreen.height / dpr}px`;
      qrCanvas.getContext('2d').drawImage(offscreen, 0, 0);
    });
  };
  if (qrSpan && qrSpanFor === token.length) return paint();
  // One-pixel squares tell how many squares this code has
  QRCode.toCanvas(offscreen, token, { scale: 1, margin: 1 }, err => {
    if (err) return;
    qrSpan = offscreen.width;
    qrSpanFor = token.length;
    paint();
  });
}

function renderQR(data) {
  if (!sessionCode) return;
  lastToken = data.token;
  drawQR(lastToken);
  scheduleTokenRefresh(500); // the QR changes constantly so screenshots stop working
}

// A resized window, a rotated phone or full screen: redraw at once, from the code already on screen
let qrResizeFrame = 0;
if (typeof ResizeObserver === 'function')
  new ResizeObserver(() => {
    cancelAnimationFrame(qrResizeFrame);
    qrResizeFrame = requestAnimationFrame(() => drawQR(lastToken));
  }).observe(qrStage);

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

// ---- scan progress: seconds so far, plus how long scans usually take (the server keeps the recent ones) ----
// No countdown to zero: a scan can wait in a queue or stop early, so a promised end time would often be wrong.
function startScanProgress(startedAt, getInfo) {
  const line = $('#cctvCountdown');
  const tick = () => {
    const { typical, others } = getInfo();
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const parts = [`Scanning… ${seconds} s`];
    if (typical) parts.push(seconds > typical * 1.5 ? 'taking longer than usual' : `usually about ${typical} s`);
    if (others > 0) parts.push(`${others} other ${others === 1 ? 'class is' : 'classes are'} also being scanned`);
    line.textContent = parts.join(' · ');
    line.hidden = false;
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => { clearInterval(timer); line.hidden = true; };
}

async function runCCTV() {
  const status = $('#liveStatus');
  cctvResult = null;
  $('#cctvError').hidden = true;
  $('#cctvSkeleton').hidden = false;
  cctvViewer.hidden = true;
  status.textContent = '';

  $('#cctvSummary').hidden = true;
  $('#cctvRescan').hidden = true;
  const scanInfo = { typical: null, others: 0 };
  const stopCountdown = startScanProgress(Date.now(), () => scanInfo);

  // While the scan runs, ask how busy the service is and how long scans usually take.
  let scanning = true;
  const askQueue = async () => {
    try {
      const queue = await (await fetch('/api/attendance/cctv/queue')).json();
      if (!scanning || !sessionCode) return;
      scanInfo.others = Math.max(0, (queue.activeScans || 0) - 1);
      scanInfo.typical = queue.typicalSeconds || null;
    } catch {
      // the hint is optional; never let it disturb the scan
    }
  };
  void askQueue();
  const watchQueue = setInterval(askQueue, 3000);
  let response;
  try {
    response = await postData('/api/attendance/cctv/run', { sessionCode });
  } finally {
    scanning = false;
    clearInterval(watchQueue);
    stopCountdown();
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

  // Only recognized CCTV students are marked present; everyone else can be added with Add manually
  const presentIds = new Set(
    response.presentStudents.map(s => String(s.student_id)),
  );
  const time = formatTime();
  response.students
    .filter(s => presentIds.has(String(s.id)))
    .forEach(s => markPresent(s.id, s.name, 'cctv', time));
  renderRoster({ force: true });
  const reported = reportedFaces(response, presentIds.size);
  cctvResult = {
    time,
    recognisedIds: presentIds,
    detected: reported, // null when the server does not say how many faces it found
  };
  renderCctvSummary();
  $('#cctvRescan').hidden = false;
  status.textContent = '';

  cctvResultImage.onload = () => {
    $('#cctvSkeleton').hidden = true;
    cctvViewer.hidden = false;
    resetView(); // every new picture starts fitted
  };
  cctvResultImage.onerror = () => {
    $('#cctvSkeleton').hidden = true;
    notify('The annotated CCTV image could not be loaded.', 'error');
  };
  cctvResultImage.src = window.apiUrl(`/results/${sessionCode}.jpg?t=${Date.now()}`);
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
  $('#manual-attendance-list').scrollTop = 0;
});

function renderManualList() {
  const q = manualQuery.trim().toLowerCase();
  // Students already in the list (present, or struck through) are handled there, not here
  const pending = [...allStudents.values()].filter(s => !roster.has(s.id));
  const pendingIds = new Set(pending.map(s => s.id));
  for (const id of manualSelected)
    if (!pendingIds.has(id)) manualSelected.delete(id);

  manualShown = pending.filter(
    s =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      idLabel(s).toLowerCase().includes(q),
  );
  const list = $('#manual-attendance-list');
  list.dataset.hasRoll = pending.some(s => idLabel(s)) ? 'true' : 'false';
  list.replaceChildren(
    ...manualShown.map(student => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'pick-row';
      label.dataset.selected = manualSelected.has(student.id) ? 'true' : 'false';
      const roll = document.createElement('span');
      roll.className = 'pick-roll';
      roll.textContent = idLabel(student);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = student.id;
      box.checked = manualSelected.has(student.id);
      const name = document.createElement('span');
      name.className = 'pick-name';
      name.textContent = student.name;
      label.append(roll, box, name);
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
  box.closest('.pick-row').dataset.selected = box.checked ? 'true' : 'false';
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
  showToast(
    `Attendance submitted: ${presentStudentIds.length}${total ? ` of ${total}` : ''} present.`,
    'success',
  );
  endSessionUI();
});

// Started by mistake: drop the session so the period is free again (for example for a faculty it was borrowed from).
// Works before Submit only. If students are already marked, the dialog says how many marks will go, and the server
// refuses to delete more than that number.
const discardDialog = $('#discard-dialog');
let discardCount = 0;

function describeDiscard(count, changed = false) {
  discardCount = count;
  $('#discardText').textContent =
    'The period becomes free again, so another faculty (or you) can start it. This cannot be undone.';
  const warn = $('#discardWarn');
  warn.hidden = count === 0;
  warn.textContent = count
    ? `${changed ? 'More students were marked just now. ' : ''}${count} student${count === 1 ? '' : 's'} marked present will be removed.`
    : '';
}

$('#discardBtn').addEventListener('click', () => {
  describeDiscard(roster.size);
  discardDialog.showModal();
});
$('#keepSessionBtn').addEventListener('click', () => discardDialog.close());
$('#confirmDiscardBtn').addEventListener('click', async event => {
  const btn = event.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  const response = await postData('/api/session/cancel', {
    sessionCode,
    facultyId,
    force: discardCount > 0,
    confirmMarked: discardCount,
  });
  btn.removeAttribute('aria-busy');
  // More students scanned while the dialog was open: show the new count and ask again
  if (response?.error === 'marks_changed' || response?.error === 'session_has_marks') {
    describeDiscard(response.marked, true);
    return;
  }
  discardDialog.close();
  if (!response?.ok)
    return notify(`Could not discard the session. ${friendlyError(response?.error, response)}`, 'error');
  showToast(
    response.removed
      ? `Session discarded. ${response.removed} student${response.removed === 1 ? '' : 's'}' marks removed.`
      : 'Session discarded. The period is free again.',
    'success',
  );
  endSessionUI();
});

function endSessionUI() {
  clearTimeout(qrTimer);
  clearTimeout(renderTimer);
  if (sessionCode) forgetRemoved(sessionCode);
  sessionCode = null;
  sessionMethod = null;
  headerInfo = null;
  lastToken = null;
  $('#qrLive').hidden = true;
  if (discardDialog.open) discardDialog.close();
  renderSessionHeader();
  roster.clear();
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
  cctvResultImage.removeAttribute('src');
  resetView();
  $('#cctvSkeleton').hidden = false;
  $('#cctvError').hidden = true;
  $('#qrError').hidden = true;
  connBanner.hidden = true;
  refreshFailures = 0;
  afterStart.hidden = true;
  beforeStart.hidden = false;
  refreshSetup(); // periods taken or borrowed in the meantime show up right away
}

syncDateChip();
loadSlots();
resumeIfOpen();
