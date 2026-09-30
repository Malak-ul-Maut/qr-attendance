import { getCurrentUser, logout } from '/utils/storage.js';

let currentConfig = null;
let editingId = null;
let studentMetadata = null;

// ==================== Initialize Dashboard ====================
initializeDashboard();

async function initializeDashboard() {
  document.querySelector('.user-name b').textContent =
    getCurrentUser().name || 'Admin';

  document
    .querySelector('.logout-btn')
    .addEventListener('click', () => logout());

  // Load and display statistics
  const response = await fetch('/api/admin/stats');
  const data = await response.json();

  document.getElementById('studentCount').textContent = data.stats.students;
  document.getElementById('facultyCount').textContent = data.stats.faculty;
  document.getElementById('liveSessionCount').textContent =
    data.stats.liveSessions;
  document.getElementById('attendanceCount').textContent =
    data.stats.attendance;

  // Setup section managers
  setupSectionManager({
    navSelector: '.student-nav',
    linkCardSelector: '.student-link-card',
    sectionSelector: '.students',
    modalId: 'studentModal',
    tableId: 'studentsTable',
    addBtnId: 'addStudentBtn',
    saveBtnId: 'saveStudentBtn',
    closeBtnId: 'closeStudentModalBtn',
    apiEndpoint: '/api/students',
    entityName: 'Student',
    needsFaceRecognition: true,
    studentForm: true,
    fields: [
      { id: 'studentName', fieldName: 'name' },
      { id: 'studentUsername', fieldName: 'username' },
      { id: 'studentPassword', fieldName: 'password' },
      { id: 'studentRollNumber', fieldName: 'rollNumber' },
      { id: 'studentCourse', fieldName: 'courseId' },
      { id: 'studentBranch', fieldName: 'branchId' },
      { id: 'studentSemester', fieldName: 'semester' },
      { id: 'studentClass', fieldName: 'classId' },
    ],
    usernameField: 'username',
  });
  initializeStudentForm();

  setupSectionManager({
    navSelector: '.faculty-nav',
    sectionSelector: '.faculty',
    linkCardSelector: '.faculty-link-card',
    modalId: 'facultyModal',
    tableId: 'facultyTable',
    addBtnId: 'addFacultyBtn',
    saveBtnId: 'saveFacultyBtn',
    closeBtnId: 'closeFacultyModalBtn',
    apiEndpoint: '/api/faculty',
    entityName: 'Faculty',
    needsFaceRecognition: false,
    fields: [
      { id: 'facultyUsername', fieldName: 'username' },
      { id: 'facultyName', fieldName: 'name' },
      {
        id: 'facultyPassword',
        fieldName: 'password',
      },
      { id: 'facultySubject', fieldName: 'subjectName' },
      { id: 'facultySection', fieldName: 'section' },
    ],
    usernameField: 'username',
  });
}

// ==================== Generic Section Manager ====================
function showSection(config) {
  // Hide all sections
  document.querySelector('.homepage').style.display = 'none';
  document.querySelector('.students').style.display = 'none';
  document.querySelector('.faculty').style.display = 'none';
  document.querySelector('.attendance').style.display = 'none';

  currentConfig = config;

  // Show current section
  document.querySelector(config.sectionSelector).style.display = 'block';
  loadEntities(config);
}

function setupSectionManager(config) {
  const nav = document.querySelector(config.navSelector);
  const linkCard = document.querySelector(config.linkCardSelector);
  const modal = document.getElementById(config.modalId);
  const addBtn = document.getElementById(config.addBtnId);
  const saveBtn = document.getElementById(config.saveBtnId);
  const closeBtn = modal.querySelector(`[id="${config.closeBtnId}"]`);

  nav.addEventListener('click', () => showSection(config));
  linkCard.addEventListener('click', () => showSection(config));

  addBtn.onclick = () => {
    editingId = null;
    clearFormFields(config);
    if (config.studentForm) updateMatchingClasses();
    modal.showModal();
  };

  closeBtn.onclick = () => {
    modal.close();
  };

  saveBtn.onclick = async () => {
    await saveEntity(config);
  };
}

// ==================== Generic Entity Operations ====================
async function loadEntities(config) {
  const response = await fetch(config.apiEndpoint);
  const entities = await response.json();

  new gridjs.Grid({
    columns: ['Name', 'Username', 'Section', 'Actions'],
    data: entities.map(entity => [
      entity.name,
      entity[config.usernameField],
      entity.section,
      gridjs.html(
        `<button onclick="window.editEntity('${encodeURIComponent(JSON.stringify(entity))}')">Edit</button>
         <button onclick="window.deleteEntity('${entity[config.usernameField]}', '${config.apiEndpoint}', '${config.entityName}')" class="button-secondary">Delete</button>`,
      ),
    ]),
    style: {
      td: {
        border: '1px solid #ccc',
      },
      table: {
        'font-size': '18px',
      },
    },
    width: '70%',
    height: '500px',
    search: true,
    pagination: { limit: 15 },
    fixedHeader: true,
    sort: true,
  }).render(document.getElementById(config.tableId));
}

async function saveEntity(config) {
  const data = {};

  config.fields.forEach(field => {
    const value = document.getElementById(field.id).value;
    if (!value) {
      throw new Error(`Missing required field: ${field.fieldName}`);
    }
    data[field.fieldName] = value;
  });

  if (config.studentForm && data.username !== editingId) {
    data.username = data.username.trim();
    const usernameStatus = document.getElementById('studentUsernameStatus');
    usernameStatus.textContent = 'Checking username...';
    const availability = await fetch(
      `${config.apiEndpoint}/username-available?username=${encodeURIComponent(data.username)}`,
    ).then(response => response.json());
    if (!availability.available) {
      usernameStatus.textContent = 'Username is already in use';
      alert('Choose a username that is not already in use');
      return;
    }
    usernameStatus.textContent = 'Username is available';
  }

  // Only process face recognition for students
  if (config.needsFaceRecognition) {
    await loadModels();

    const files = document.getElementById('faceImages').files;

    if (files.length === 0 && !editingId) {
      alert('Upload at least one face image');
      return;
    }

    document.getElementById('faceStatus').textContent = 'Processing faces...';

    const descriptors = await getDescriptorsFromImages(files);

    if (descriptors.length === 0 && !editingId) {
      alert('No valid faces detected');
      return;
    }

    if (descriptors.length > 0 && descriptors.length < 3) {
      alert('Upload at least 3 images for better accuracy');
    }

    // Only compute centroid if there are descriptors
    if (descriptors.length > 0) {
      const centroid = computeCentroid(descriptors);
      data.faceDescriptor = JSON.stringify(Array.from(centroid));
    }
  }

  let method = 'POST';
  let url = config.apiEndpoint;

  if (editingId) {
    method = 'PUT';
    url = `${config.apiEndpoint}/${editingId}`;
  }

  let requestBody = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json' };
  if (config.studentForm && method === 'POST') {
    data.faceImages = await Promise.all(
      Array.from(document.getElementById('faceImages').files, file =>
        readImageDataUrl(file),
      ),
    );
    requestBody = JSON.stringify(data);
  }

  const response = await fetch(url, { method, headers, body: requestBody });

  if (response.ok) {
    setTimeout(() => {
      editingId = null;
      document.getElementById(config.modalId).close();
      location.reload();
    }, 2000);
  } else {
    const result = await response.json().catch(() => ({}));
    alert(
      result.error === 'username_taken'
        ? 'Username is already in use'
        : 'Error saving entity',
    );
  }
}

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function initializeStudentForm() {
  const response = await fetch('/api/students/meta');
  if (!response.ok) throw new Error('Could not load student options');
  studentMetadata = await response.json();
  populateSelect('studentCourse', studentMetadata.courses, 'Select course');
  populateSelect('studentBranch', studentMetadata.branches, 'Select branch');

  for (const id of ['studentCourse', 'studentBranch', 'studentSemester']) {
    document
      .getElementById(id)
      .addEventListener('change', updateMatchingClasses);
  }
  document
    .getElementById('studentUsername')
    .addEventListener('blur', checkStudentUsername);
}

function populateSelect(id, options, placeholder) {
  const select = document.getElementById(id);
  select.replaceChildren(new Option(placeholder, ''));
  options.forEach(option => select.add(new Option(option.label, option.id)));
}

function updateMatchingClasses() {
  if (!studentMetadata) return;
  const courseId = document.getElementById('studentCourse').value;
  const branchId = document.getElementById('studentBranch').value;
  const semester = Number(document.getElementById('studentSemester').value);
  const matching = studentMetadata.classes.filter(
    item =>
      String(item.course_id) === courseId &&
      String(item.branch_id) === branchId &&
      item.semester === semester,
  );
  const placeholder =
    courseId && branchId && semester
      ? 'Select class'
      : 'Select course, branch, and semester first';
  populateSelect(
    'studentClass',
    matching.map(item => ({
      id: item.id,
      label: `Class ${item.id} - ${item.section}`,
    })),
    placeholder,
  );
  document.getElementById('studentClass').disabled = matching.length === 0;
}

async function checkStudentUsername() {
  const input = document.getElementById('studentUsername');
  const username = input.value.trim();
  const status = document.getElementById('studentUsernameStatus');
  if (!username) {
    status.textContent = '';
    return;
  }
  const response = await fetch(
    `/api/students/username-available?username=${encodeURIComponent(username)}`,
  );
  const result = await response.json();
  status.textContent = result.available
    ? 'Username is available'
    : 'Username is already in use';
}

function editEntity(encodedEntity) {
  const config = currentConfig;
  const modal = document.getElementById(config.modalId);

  const entity = JSON.parse(decodeURIComponent(encodedEntity));
  editingId = entity[config.usernameField];

  document.querySelector(`#${config.modalId} h3`).textContent =
    `Edit ${config.entityName}`;

  // Prefill form fields
  if (config.studentForm) {
    config.fields
      .filter(field => field.id !== 'studentClass')
      .forEach(field => {
        document.getElementById(field.id).value = entity[field.fieldName] || '';
      });
    updateMatchingClasses();
    document.getElementById('studentClass').value = entity.classId || '';
  } else {
    config.fields.forEach(field => {
      document.getElementById(field.id).value = entity[field.fieldName] || '';
    });
  }

  modal.showModal();
}

async function deleteEntity(id, apiEndpoint, entityName) {
  if (!confirm(`Delete this ${entityName}?`)) return;

  const response = await fetch(`${apiEndpoint}/${id}`, {
    method: 'DELETE',
  });

  if (response.ok) {
    location.reload();
  } else {
    alert(`Error deleting ${entityName}`);
  }
}

function clearFormFields(config) {
  config.fields.forEach(field => {
    document.getElementById(field.id).value = '';
  });

  document.querySelector(`#${config.modalId} h3`).textContent =
    `Add ${config.entityName}`;
  if (config.studentForm) {
    document.getElementById('studentPassword').value = 'password';
    document.getElementById('studentUsernameStatus').textContent = '';
    document.getElementById('faceImages').value = '';
    document.getElementById('faceStatus').textContent = 'No images uploaded';
  }
}

async function getDescriptorsFromImages(files) {
  const descriptors = [];

  const saveBtn = document.getElementById('saveStudentBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Processing...';

  const faceStatus = document.getElementById('faceStatus');

  for (let i = 0; i < files.length; i++) {
    faceStatus.textContent = `Processing image ${i + 1} of ${files.length}...`;

    const img = await faceapi.bufferToImage(files[i]);

    const detection = await faceapi
      .detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      console.warn('No face detected in image');
      continue;
    }

    if (detection.detection.score < 0.7) {
      console.warn('Low confidence face skipped');
      continue;
    }

    descriptors.push(detection.descriptor);

    console.log('Face added:', detection.detection.score);
  }

  faceStatus.textContent = 'Saved successfully ✅';
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save';
  return descriptors;
}

function computeCentroid(descriptors) {
  if (!descriptors || descriptors.length === 0) {
    throw new Error('No face descriptors provided');
  }

  const length = descriptors[0].length;
  const centroid = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const desc of descriptors) {
      sum += desc[i];
    }
    centroid[i] = sum / descriptors.length;
  }

  return centroid;
}

async function loadModels() {
  await cacheModelsFromManifest('/utils/models/models-manifest.json');

  // Load models
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri('/utils/models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('/utils/models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('/utils/models'),
  ]).then(() => console.log('models loaded'));
}

// ==================== Global Functions for Onclick Handlers ====================
window.editEntity = editEntity;
window.deleteEntity = deleteEntity;
