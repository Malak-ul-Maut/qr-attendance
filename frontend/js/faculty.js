import { getCurrentUser, logout } from '/utils/storage.js';
import postData from '/utils/fetch.js';

const beforeStart = document.querySelector('#beforeStart');
const afterStart = document.querySelector('#afterStart');
const canvas = document.querySelector('canvas');
const liveSection = document.querySelector('.live-section');
const studentList = document.querySelector('#studentList');
const studentCount = document.querySelector('#studentCount');
const addManuallyBtn = document.querySelector('#add-manually-btn');
const dialog = document.querySelector('#manual-attendance-dialog');
const addSelectedBtn = document.querySelector('#add-selected-btn');
const startBtn = document.querySelector('#startSessionBtn');
const methodDropdown = document.querySelector('#attendance-method');
const classSelection = document.querySelector('#class-selection');
const classesPara = document.querySelector('#classes');

let sessionCode = null;
let qrTimer = null;
const classIds = [];

const currentUser = getCurrentUser();
const facultyId = currentUser.username;

const toggleFullScreenBtn = document.querySelector('.toggle-fullscreen-btn');
toggleFullScreenBtn.addEventListener('click', () => toggleFullScreen());

// Display username and subject
const userName = document.querySelector('.user-name b');
userName.textContent = currentUser.name || 'Teacher';

const subjectName = document.querySelector('#sub-name');
subjectName.textContent = currentUser.subName || currentUser.subjectName || '';

document.querySelector('.logout-btn').addEventListener('click', () => logout());

const dateElement = document.querySelector('#date');
const slotsDropdown = document.querySelector('#slots');

// Use today's date when the page opens. The teacher can still change it for testing.
if (!dateElement.value) {
  dateElement.value = new Date().toISOString().slice(0, 10);
}

async function loadSlots() {
  slotsDropdown.innerHTML = '';
  classesPara.innerHTML = '';

  const res = await fetch(
    `/api/session/slots?date=${encodeURIComponent(dateElement.value)}&faculty_id=${encodeURIComponent(facultyId)}`,
  );
  const slotsList = await res.json();

  slotsList.forEach(slot => {
    const option = document.createElement('option');
    option.value = slot.id;
    option.textContent = `${slot.label}: ${slot.start_time} - ${slot.end_time}`;
    slotsDropdown.appendChild(option);
  });

  await loadClasses();
}

dateElement.addEventListener('change', loadSlots);
slotsDropdown.addEventListener('change', loadClasses);

methodDropdown.addEventListener('change', () => {
  const isCCTV = methodDropdown.value === 'cctv';
  classSelection.style.display = isCCTV ? 'block' : 'none';
  canvas.style.display = isCCTV ? 'none' : '';
});

async function loadClasses() {
  classesPara.innerHTML = '';

  if (!slotsDropdown.value) {
    classSelection.style.display = 'none';
    return;
  }

  const res = await fetch(
    `/api/session/classes?date=${encodeURIComponent(dateElement.value)}&slotId=${encodeURIComponent(slotsDropdown.value)}&faculty_id=${encodeURIComponent(facultyId)}`,
  );
  const classes = await res.json();

  classes.forEach(item => {
    classIds.push(item.class_id);
    const para = document.createElement('p');
    para.value = item.class_id;
    para.textContent = `${item.course} (${item.branch}) • Sem ${item.semester} • Section ${item.section}`;
    classesPara.appendChild(para);
  });

  classSelection.style.display =
    methodDropdown.value === 'cctv' ? 'block' : 'none';
}

// --------------- Socket initialization -------------
const socket = io(location.origin);

socket.on('attendance_update', data => {
  if (String(data.sessionCode || data.sessionId) !== String(sessionCode))
    return;
  if (markedStudents.has(String(data.studentId))) return;

  markedStudents.add(String(data.studentId));

  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = `${data.studentName} (${data.time})`;
  span.dataset.id = data.studentId;

  const checkBox = document.createElement('input');
  checkBox.type = 'checkbox';
  checkBox.checked = true;
  checkBox.dataset.id = data.studentId;

  checkBox.addEventListener('change', () => {
    span.classList.toggle('strike', !checkBox.checked);
    updatePresentCount();
  });

  li.appendChild(span);
  li.appendChild(checkBox);
  studentList.appendChild(li);
  li.scrollIntoView();
  updatePresentCount();
});

const markedStudents = new Set();

// Start session
startBtn.addEventListener('click', async () => {
  const slotId = slotsDropdown.value;
  const date = dateElement.value;
  const method = methodDropdown.value;

  if (!slotId) return alert('Please select a slot.');

  startBtn.disabled = true;

  try {
    const response = await postData('/api/session/start', {
      date,
      slotId,
      facultyId,
      method,
      classIds,
    });

    if (!response.ok) {
      console.error('Start session failed:', response);
      alert(`Could not start session: ${response.error || 'unknown error'}`);
      return;
    }

    sessionCode = response.sessionCode;
    markedStudents.clear();
    socket.emit('join_session', sessionCode);

    beforeStart.style.display = 'none';
    afterStart.style.display = 'flex';

    if (method === 'qr') {
      canvas.style.display = '';
      renderQR(response);
    } else {
      canvas.style.display = 'none';
      studentCount.textContent = 'CCTV: processing...';
      await runCCTV();
    }
  } finally {
    startBtn.disabled = false;
  }
});

async function runCCTV() {
  const response = await postData('/api/attendance/cctv/run', { sessionCode });

  if (!response.ok) {
    console.error('CCTV processing failed:', response);
    studentCount.textContent = 'CCTV processing failed';
    alert(`CCTV attendance failed: ${response.error || 'unknown error'}`);
    return;
  }

  studentCount.textContent = `Present: ${response.presentStudents.length}`;
}

addManuallyBtn.addEventListener('click', async () => {
  const res = await fetch(`/api/students/${sessionCode}`);
  const students = await res.json();

  const unmarkedStudents = students.filter(
    s => !markedStudents.has(String(s.id)),
  );

  showManualPopup(unmarkedStudents);
});

addSelectedBtn.addEventListener('click', async () => {
  const selected = document.querySelectorAll(
    '#manual-attendance-list input:checked',
  );

  const students = [];

  selected.forEach(cb => {
    students.push({
      id: cb.value,
      name: cb.dataset.name,
    });
  });

  await postData('/api/attendance/manual', {
    sessionCode,
    students,
  });

  dialog.close();
});

// Submit attendance and end session
document
  .querySelector('#submit-attendance-btn')
  .addEventListener('click', async () => {
    const students = studentList.querySelectorAll('input[type=checkbox]');
    const keepStudentIds = [];

    students.forEach(student => {
      if (student.checked) keepStudentIds.push(student.dataset.id);
    });

    const response = await postData('/api/session/finalize', {
      sessionCode,
      keepStudentIds,
    });

    if (!response.ok)
      return console.error('Finalize returned error:', response);

    alert('✔ Attendance submitted successfully');
    clearAttendanceUI();
  });

function renderQR(data) {
  const options = {
    width: canvas.clientWidth,
    height: canvas.clientWidth,
    margin: 2,
  };
  QRCode.toCanvas(canvas, data.token, options);

  qrTimer = setTimeout(async () => {
    const tokenData = await postData('/api/session/token', { sessionCode });
    if (!tokenData.ok) return console.warn('Token refresh failed:', tokenData);
    renderQR(tokenData);
  }, 500);
}

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    afterStart.classList.add('afterStart-fs');
    canvas.classList.add('canvas-fs');
    liveSection.classList.add('live-section-fs');
    afterStart.requestFullscreen();
  } else {
    afterStart.classList.remove('afterStart-fs');
    canvas.classList.remove('canvas-fs');
    liveSection.classList.remove('live-section-fs');
    document.exitFullscreen();
  }
}

function clearAttendanceUI() {
  studentCount.textContent = 'Present: 0';
  studentList.textContent = '';
  markedStudents.clear();
  afterStart.style.display = 'none';
  beforeStart.style.display = 'flex';
  clearTimeout(qrTimer);
  sessionCode = null;
}

function updatePresentCount() {
  const checkedStudents = document.querySelectorAll(
    '#studentList input[type="checkbox"]:checked',
  ).length;

  studentCount.textContent = `Present: ${checkedStudents}`;
}

function showManualPopup(students) {
  const container = document.querySelector('#manual-attendance-list');
  container.innerHTML = '';

  students.forEach(student => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = student.name;
    span.dataset.id = student.id;

    const checkBox = document.createElement('input');
    checkBox.type = 'checkbox';
    checkBox.value = student.id;
    checkBox.dataset.name = student.name;

    li.appendChild(span);
    li.appendChild(checkBox);
    container.appendChild(li);
  });

  dialog.showModal();
}

// Populate the initial slot/class controls.
loadSlots().catch(error => console.error('Could not load timetable:', error));
