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
let sessionId = null;
let qrTimer = null;

// Display username, subject and section
const userName = document.querySelector('.user-name b');
userName.textContent = getCurrentUser().name || 'Teacher';

const subjectName = document.querySelector('#sub-name');
subjectName.textContent = getCurrentUser().subName;

const logoutBtn = document.querySelector('.logout-btn');
logoutBtn.addEventListener('click', () => logout());

const sectionDropdown = document.querySelector('#section');
sectionDropdown.innerHTML = '';
const sections = getCurrentUser().section.split(',');
sections.forEach(sec => {
  const option = document.createElement('option');
  option.value = sec.trim();
  option.textContent = sec.trim();
  sectionDropdown.appendChild(option);
});

// --------------- Socket initialization -------------
const socket = io(location.origin);

socket.on('connect', () => {
  socket.emit('register_teacher', sessionId);
});

// Dynamically generate html for attendance list
const markedStudents = new Set();

socket.on('attendance_update', data => {
  markedStudents.add(data.studentId);

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

// Start session
const startBtn = document.querySelector('#startSessionBtn');

startBtn.addEventListener('click', async () => {
  const section = document.querySelector('#section').value;
  const teacherId = getCurrentUser().username;

  const toggleFullScreenBtn = document.querySelector('.toggle-fullscreen-btn');
  toggleFullScreenBtn.addEventListener('click', () => toggleFullScreen());

  const response = await postData('/api/session/start', { section, teacherId });
  sessionId = response.sessionId;
  socket.emit('join_session', sessionId);

  beforeStart.style.display = 'none';
  afterStart.style.display = 'flex';

  if (qrTimer) clearTimeout(qrTimer);
  renderQR(response);
});

addManuallyBtn.addEventListener('click', async () => {
  const section = document.querySelector('#section').value;

  const res = await fetch(`/api/students/${section}`);
  const students = await res.json();

  console.log(students);

  const unmarkedStudents = students.filter(
    s => !markedStudents.has(s.username),
  );
  console.log(unmarkedStudents);

  showManualPopup(unmarkedStudents);
});

addSelectedBtn.addEventListener('click', async () => {
  const section = document.querySelector('#section').value;
  const selected = document.querySelectorAll(
    '#manual-attendance-list input:checked',
  );

  const students = [];

  selected.forEach(cb => {
    students.push({
      studentId: cb.value,
      studentName: cb.dataset.name,
      section,
    });
  });

  await postData('/api/attendance/manual', {
    sessionId: sessionId,
    students: students,
    section,
  });

  dialog.close();
});

// Submit attendance and end session

const submitBtn = document.querySelector('#submit-attendance-btn');

submitBtn.addEventListener('click', async () => {
  const students = studentList.querySelectorAll('input[type=checkbox]');
  const keepStudentIds = [];

  students.forEach(student => {
    if (student.checked) keepStudentIds.push(student.dataset.id);
  });

  const response = await postData('/api/session/finalize', {
    sessionId,
    keepStudentIds,
  });
  if (!response.ok) return console.error('Finalize returned error:', data);

  alert('✔ Attendance submitted successfully');
  if (document.fullscreenElement) toggleFullScreen();
  clearAttendanceUI();
});

// ------------- Functions ---------------

function renderQR(data) {
  const canvas = document.querySelector('canvas');
  const options = {
    width: canvas.clientWidth,
    height: canvas.clientWidth,
    margin: 2,
  };
  QRCode.toCanvas(canvas, data.token, options);

  qrTimer = setTimeout(async () => {
    const tokenData = await postData('/api/session/token', { sessionId });
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
  afterStart.style.display = 'none';
  beforeStart.style.display = 'flex';
  clearTimeout(qrTimer);
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
    span.dataset.id = student.username;

    const checkBox = document.createElement('input');
    checkBox.type = 'checkbox';
    checkBox.value = student.username;
    checkBox.dataset.name = student.name;

    li.appendChild(span);
    li.appendChild(checkBox);
    container.appendChild(li);
  });

  dialog.showModal();
}
