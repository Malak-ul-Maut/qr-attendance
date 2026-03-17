import { getCurrentUser, logout } from '/utils/storage.js';

let currentConfig = null;
let editingId = null;

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
    fields: [
      { id: 'studentName', fieldName: 'name' },
      {
        id: 'studentUsername',
        fieldName: 'username',
      },
      {
        id: 'studentPassword',
        fieldName: 'password',
      },
      { id: 'studentSection', fieldName: 'section' },
    ],
    usernameField: 'username',
  });

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
function setupSectionManager(config) {
  const nav = document.querySelector(config.navSelector);
  const linkCard = document.querySelector(config.linkCardSelector);
  const section = document.querySelector(config.sectionSelector);
  const modal = document.getElementById(config.modalId);
  const addBtn = document.getElementById(config.addBtnId);
  const saveBtn = document.getElementById(config.saveBtnId);
  const closeBtn = modal.querySelector(`[id="${config.closeBtnId}"]`);

  nav.addEventListener('click', () => {
    // Hide all sections
    document.querySelector('.homepage').style.display = 'none';
    document.querySelector('.students').style.display = 'none';
    document.querySelector('.faculty').style.display = 'none';
    document.querySelector('.attendance').style.display = 'none';

    currentConfig = config;

    // Show current section
    section.style.display = 'block';
    loadEntities(config);
  });

  linkCard.addEventListener('click', () => {
    // Hide all sections
    document.querySelector('.homepage').style.display = 'none';
    document.querySelector('.students').style.display = 'none';
    document.querySelector('.faculty').style.display = 'none';
    document.querySelector('.attendance').style.display = 'none';

    currentConfig = config;

    // Show current section
    section.style.display = 'block';
    loadEntities(config);
  });

  addBtn.onclick = () => {
    editingId = null;
    clearFormFields(config);
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
    search: true,
    pagination: { limit: 15 },
    sort: true,
  }).render(document.getElementById(config.tableId));
}

async function saveEntity(config) {
  const data = {};

  config.fields.forEach(field => {
    const value = document.getElementById(field.id).value;
    if (!value) {
      alert(`Please fill in ${field.placeholder}`);
      throw new Error(`Missing required field: ${field.placeholder}`);
    }
    data[field.fieldName] = value;
  });

  let method = 'POST';
  let url = config.apiEndpoint;

  if (editingId) {
    method = 'PUT';
    url = `${config.apiEndpoint}/${editingId}`;
  }

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (response.ok) {
    editingId = null;
    document.getElementById(config.modalId).close();
    location.reload();
  } else {
    alert('Error saving entity');
  }
}

function editEntity(encodedEntity) {
  const config = currentConfig;
  const modal = document.getElementById(config.modalId);

  const entity = JSON.parse(decodeURIComponent(encodedEntity));
  editingId = entity[config.usernameField];

  document.querySelector(`#${config.modalId} h3`).textContent =
    `Edit ${config.entityName}`;

  // Prefill form fields
  config.fields.forEach(field => {
    document.getElementById(field.id).value = entity[field.fieldName] || '';
  });

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
}

// ==================== Global Functions for Onclick Handlers ====================
window.editEntity = editEntity;
window.deleteEntity = deleteEntity;
