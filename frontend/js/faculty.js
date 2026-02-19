import { getCurrentUser, logout } from '/utils/storage.js';
import postData from '/utils/fetch.js';

const beforeStart = document.querySelector('#beforeStart');
const afterStart = document.querySelector('#afterStart');
const canvas = document.querySelector('canvas');
const liveSection = document.querySelector('.live-section');
const studentList = document.querySelector('#studentList');
const studentCount = document.querySelector('#studentCount');
let sessionId = null;
let qrTimer = null;

const currentUser = getCurrentUser();
console.log('Teacher Section:', currentUser.section);


// Display user and subject name
const userName = document.querySelector('.user-name b');
userName.textContent = currentUser.name || 'Teacher';

const subjectName = document.querySelector('#sub-name');
subjectName.textContent = currentUser.subName;

// Display teacher's assigned section
const sectionDropdown = document.getElementById('section');
sectionDropdown.innerHTML = '';

if(currentUser.section) {
 const sections = currentUser.section.split(',');
 sections.forEach(sec => {
  const option = document.createElement('option');
  option.value = sec.trim();
  option.textContent = sec.trim();
  sectionDropdown.appendChild(option);
 });
}

const logoutBtn = document.querySelector('.logout-btn');
logoutBtn.addEventListener('click', () => logout());

// --------------- Socket initialization -------------
const socket = io(location.origin);

socket.on('connect', () => {
  socket.emit('register_teacher');
});

// Dynamically generate html for attendance list
socket.on('attendance_update', data => {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = `${data.studentName} (${data.time})`;
  span.dataset.id = data.studentId;

  const checkBox = document.createElement('input');
  checkBox.type = 'checkbox';
  checkBox.checked = true;
  checkBox.dataset.id = data.studentId;

  li.appendChild(span);
  li.appendChild(checkBox);
  studentList.appendChild(li);
  li.scrollIntoView();
  studentCount.textContent = `Present: ${studentList.children.length}`;
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

  beforeStart.style.display = 'none';
  afterStart.style.display = 'flex';

  if (qrTimer) clearTimeout(qrTimer);
  renderQR(response);
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
