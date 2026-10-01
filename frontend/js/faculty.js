import { getCurrentUser, logout } from '/utils/storage.js';
import postData from '/utils/fetch.js';
import { showToast } from './ui.js';

const $ = sel => document.querySelector(sel);
const currentUser = getCurrentUser();
const facultyId = currentUser.username;

// ---------- Page basics ----------
$('.user-name b').textContent = currentUser.name || 'Teacher';
$('#sub-name').textContent =
  currentUser.subName || currentUser.subjectName || '';
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
    // Land on the new heading so screen-reader users hear where they are
    document
      .querySelector(`#view-${tab.dataset.view} h1.section-title`)
      ?.focus({ preventScroll: true });
  });
});

// Call when the backend can list past sessions.
// sessions: [{ date, slot, method, present, total }]
export function renderHistory(sessions) {
  $('#historyEmpty').hidden = sessions.length > 0;
  $('#historyList').replaceChildren(
    ...sessions.map(s => {
      const li = document.createElement('li');
      li.className = 'card list-row';
      const text = document.createElement('span');
      text.textContent = `${s.date} · ${s.slot} · ${s.method.toUpperCase()}`;
      const badge = document.createElement('span');
      badge.className = 'badge badge-success';
      badge.textContent = `${s.present}/${s.total} present`;
      li.append(text, badge);
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
const qrCanvas = $('#qrCanvas');
const studentList = $('#studentList');
const startBtn = $('#startSessionBtn');
const dateInput = $('#date');
const slotList = $('#slots');
const classSelection = $('#class-selection');
const classesBox = $('#classes');
const manualDialog = $('#manual-attendance-dialog');
const submitDialog = $('#submit-dialog');

let sessionCode = null;
let qrTimer = null;
let classIds = [];
let slotRequestId = 0;
const roster = new Map(); // studentId -> { name, time, source: 'qr'|'cctv'|'manual', present }
const manualIds = new Set(); // ids the teacher added by hand

const getMethod = () => $('input[name="method"]:checked').value;
const getSlotId = () => $('input[name="slot"]:checked')?.value;

// ---------- Setup: date, slots, classes ----------
dateInput.value ||= new Date().toISOString().slice(0, 10); // today; teacher can change it

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
  classesBox.replaceChildren();
  startBtn.disabled = true;

  try {
    const res = await fetch(
      `/api/session/slots?date=${encodeURIComponent(dateInput.value)}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    if (!res.ok) throw new Error();
    const slots = await res.json();
    if (requestId !== slotRequestId) return;

    slotList.replaceChildren(
      ...slots.map((slot, i) => {
        const label = document.createElement('label');
        label.className = 'slot-card';
        label.innerHTML =
          '<input type="radio" name="slot"><span class="slot-body"><span class="slot-label"></span><span class="slot-time"></span></span>';
        const input = label.querySelector('input');
        input.value = slot.id;
        input.checked = i === 0; // first slot pre-selected
        input.addEventListener('change', loadClasses);
        label.querySelector('.slot-label').textContent = slot.label;
        label.querySelector('.slot-time').textContent =
          `${slot.start_time} – ${slot.end_time}`;
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
  classesBox.replaceChildren();
  classIds = []; // reset every time so old ids never pile up
  if (!getSlotId()) return updateClassVisibility();

  try {
    const res = await fetch(
      `/api/session/classes?date=${encodeURIComponent(dateInput.value)}&slotId=${encodeURIComponent(getSlotId())}&faculty_id=${encodeURIComponent(facultyId)}`,
    );
    const classes = await res.json();
    classes.forEach(item => {
      classIds.push(item.class_id);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${item.course} (${item.branch}) · Sem ${item.semester} · Section ${item.section}`;
      classesBox.appendChild(chip);
    });
  } catch {
    notify('Could not load the classes for this slot.', 'error');
  }
  updateClassVisibility();
}

function updateClassVisibility() {
  classSelection.hidden = getMethod() !== 'cctv' || classIds.length === 0;
}

dateInput.addEventListener('change', loadSlots);
document
  .querySelectorAll('input[name="method"]')
  .forEach(r => r.addEventListener('change', updateClassVisibility));

// ---------- Live roster ----------
function addToRoster(id, name, time, source, present = true) {
  id = String(id);
  if (roster.has(id)) return false;
  roster.set(id, {
    name,
    time,
    source: manualIds.has(id) ? 'manual' : source,
    present,
  });
  renderRoster();
  return true;
}

function renderRoster() {
  const rows = [...roster].map(([id, s]) => {
    const li = document.createElement('li');
    li.className = `roster-row ${s.present ? '' : 'is-absent'}`;

    const info = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'roster-meta';
    const via = { qr: 'QR', cctv: 'CCTV', manual: 'Manual' }[s.source];
    meta.textContent = s.time ? `${via} · ${s.time}` : via;
    info.append(name, meta);

    // Tap to flip between Present and Absent
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `status-btn badge ${s.present ? 'badge-success' : 'badge-danger'}`;
    btn.textContent = s.present ? '✓ Present' : '✕ Absent';
    btn.setAttribute(
      'aria-label',
      `${s.name} is ${s.present ? 'present' : 'absent'}. Mark ${s.present ? 'absent' : 'present'}`,
    );
    btn.dataset.id = id;
    btn.addEventListener('click', () => {
      s.present = !s.present;
      renderRoster();
      // The list is rebuilt, so put keyboard focus back on the same student's button
      studentList
        .querySelector(`.status-btn[data-id="${CSS.escape(id)}"]`)
        ?.focus();
    });

    li.append(info, btn);
    return li;
  });
  studentList.replaceChildren(...rows);
  $('#rosterEmpty').hidden = roster.size > 0;
  $('#studentCount').textContent = [...roster.values()].filter(
    s => s.present,
  ).length;
}

// Students scanning their QR arrive through the socket
const socket = io(location.origin);
socket.on('attendance_update', data => {
  if (String(data.sessionCode || data.sessionId) !== String(sessionCode))
    return;
  if (addToRoster(data.studentId, data.studentName, data.time, 'qr')) {
    studentList.lastElementChild?.scrollIntoView({ block: 'nearest' });
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
    if (!response.ok)
      return notify(
        `Could not start session: ${response.error || 'unknown error'}`,
        'error',
      );

    sessionCode = response.sessionCode;
    roster.clear();
    manualIds.clear();
    renderRoster();
    socket.emit('join_session', sessionCode);

    beforeStart.hidden = true;
    afterStart.hidden = false;
    const isQr = method === 'qr';
    qrCanvas.hidden = !isQr;
    $('#cctvPanel').hidden = isQr;
    $('#fullscreenBtn').hidden = !isQr;
    $('#panelTitle').textContent = isQr
      ? 'Scan to mark attendance'
      : 'CCTV result';
    $('#liveStatus').textContent = isQr ? '' : 'Processing CCTV image...';
    if (isQr) renderQR(response);
    else await runCCTV();
  } catch {
    notify('Could not reach the server. Try again.', 'error');
  } finally {
    startBtn.removeAttribute('aria-busy');
    startBtn.disabled = false;
  }
});

function renderQR(data) {
  if (!sessionCode) return;
  if (typeof QRCode === 'undefined') return ($('#qrError').hidden = false);
  QRCode.toCanvas(qrCanvas, data.token, {
    width: qrCanvas.clientWidth,
    height: qrCanvas.clientWidth,
    margin: 2,
  });
  scheduleTokenRefresh(500); // the QR changes constantly so screenshots stop working
}

function scheduleTokenRefresh(delay) {
  clearTimeout(qrTimer);
  qrTimer = setTimeout(async () => {
    if (!sessionCode) return;
    const data = await postData('/api/session/token', { sessionCode }).catch(
      () => ({ ok: false }),
    );
    if (!sessionCode) return; // session ended while we waited
    if (data.ok) renderQR(data);
    else scheduleTokenRefresh(2000); // keep trying instead of freezing on an old QR
  }, delay);
}

async function runCCTV() {
  const response = await postData('/api/attendance/cctv/run', { sessionCode });
  if (!response.ok) {
    $('#liveStatus').textContent = 'CCTV processing failed';
    return notify(
      `CCTV attendance failed: ${response.error || 'unknown error'}`,
      'error',
    );
  }

  // Only recognized CCTV students should appear in the live roster. Absent students stay out of the list and are picked from the manual-add dialog instead.
  const presentIds = new Set(
    response.presentStudents.map(s => String(s.student_id)),
  );
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  response.students
    .filter(s => presentIds.has(String(s.id)))
    .forEach(s => addToRoster(s.id, s.name, time, 'cctv', true));

  const img = $('#cctvResultImage');
  img.onload = () => {
    $('#cctvSkeleton').hidden = true;
    img.hidden = false;
  };
  img.onerror = () => {
    $('#cctvSkeleton').hidden = true;
    notify('The annotated CCTV image could not be loaded.', 'error');
  };
  img.src = `/results/${sessionCode}.jpg?t=${Date.now()}`;
  $('#liveStatus').textContent = 'Check the list and fix any mistakes.';
}

const cctvResultImage = $('#cctvResultImage');
async function toggleCctvImageFullscreen() {
  try {
    if (document.fullscreenElement === cctvResultImage)
      await document.exitFullscreen();
    else await cctvResultImage.requestFullscreen();
  } catch {
    notify('Could not open the CCTV image full screen.', 'error');
  }
}
cctvResultImage.addEventListener('click', toggleCctvImageFullscreen);
cctvResultImage.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleCctvImageFullscreen();
  }
});

// ---------- Full screen (for projectors) ----------
$('#fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else afterStart.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  $('#fullscreenBtn').textContent = document.fullscreenElement
    ? 'Exit full screen'
    : 'Full screen';
});

// ---------- Add manually ----------
$('#add-manually-btn').addEventListener('click', async () => {
  try {
    const res = await fetch(`/api/students/${sessionCode}`);
    const students = await res.json();
    // Anyone not currently marked present can be added
    showManualPopup(students.filter(s => !roster.get(String(s.id))?.present));
  } catch {
    notify('Could not load the student list.', 'error');
  }
});

function showManualPopup(students) {
  const list = $('#manual-attendance-list');
  list.replaceChildren(
    ...students.map(student => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = student.id;
      box.dataset.name = student.name;
      label.append(box, document.createTextNode(student.name));
      li.appendChild(label);
      return li;
    }),
  );
  $('#manualEmpty').hidden = students.length > 0;
  $('#add-selected-btn').disabled = students.length === 0;
  manualDialog.showModal();
}

$('#closeDialog').addEventListener('click', () => manualDialog.close());

$('#add-selected-btn').addEventListener('click', async event => {
  const students = [
    ...document.querySelectorAll('#manual-attendance-list input:checked'),
  ].map(cb => ({ id: cb.value, name: cb.dataset.name }));
  if (students.length === 0)
    return notify('Tick at least one student.', 'error');

  const btn = event.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  students.forEach(s => manualIds.add(String(s.id)));
  const response = await postData('/api/attendance/manual', {
    sessionCode,
    students,
  }).catch(() => ({ ok: false }));
  btn.removeAttribute('aria-busy');

  if (!response?.ok) {
    students.forEach(s => manualIds.delete(String(s.id)));
    return notify('Could not add those students. Try again.', 'error');
  }
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  students.forEach(s => {
    const entry = roster.get(String(s.id));
    if (entry) Object.assign(entry, { present: true, source: 'manual' });
    else addToRoster(s.id, s.name, time, 'manual');
  });
  renderRoster();
  manualDialog.close();
});

// ---------- Submit (asks first, because it ends the session) ----------
$('#submit-attendance-btn').addEventListener('click', () => {
  const present = [...roster.values()].filter(s => s.present).length;
  $('#submitSummary').textContent =
    `${present} student${present === 1 ? '' : 's'} will be marked present. This ends the session.`;
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
  }).catch(() => ({ ok: false }));
  btn.removeAttribute('aria-busy');
  submitDialog.close();

  if (!response.ok)
    return notify(
      'Could not submit attendance. Nothing was lost; try again.',
      'error',
    );
  showToast('Attendance submitted.', 'success');
  endSessionUI();
});

function endSessionUI() {
  clearTimeout(qrTimer);
  sessionCode = null;
  roster.clear();
  manualIds.clear();
  if (document.fullscreenElement) document.exitFullscreen();
  $('#cctvResultImage').hidden = true;
  $('#cctvResultImage').removeAttribute('src');
  $('#cctvSkeleton').hidden = false;
  $('#qrError').hidden = true;
  renderRoster();
  afterStart.hidden = true;
  beforeStart.hidden = false;
}

loadSlots();
