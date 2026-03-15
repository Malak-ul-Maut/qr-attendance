import { getCurrentUser, logout } from '/utils/storage.js';

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
    sectionSelector: '.students',
    modalId: 'studentModal',
    tableId: 'studentsTable',
    addBtnId: 'addStudentBtn',
    saveBtnId: 'saveStudentBtn',
    closeBtnId: 'closeStudentModalBtn',
    apiEndpoint: '/api/students',
    entityName: 'Student',
    fields: [
      {
        id: 'studentUsername',
        fieldName: 'studentId',
        placeholder: 'Username',
      },
      { id: 'studentName', fieldName: 'name', placeholder: 'Student Name' },
      { id: 'studentSection', fieldName: 'section', placeholder: 'Section' },
    ],
    usernameField: 'username',
  });

  setupSectionManager({
    navSelector: '.faculty-nav',
    sectionSelector: '.faculty',
    modalId: 'facultyModal',
    tableId: 'facultyTable',
    addBtnId: 'addFacultyBtn',
    saveBtnId: 'saveFacultyBtn',
    closeBtnId: 'closeFacultyModalBtn',
    apiEndpoint: '/api/faculty',
    entityName: 'Faculty',
    fields: [
      { id: 'facultyUsername', fieldName: 'username', placeholder: 'Username' },
      { id: 'facultyName', fieldName: 'name', placeholder: 'Faculty Name' },
      { id: 'facultySection', fieldName: 'section', placeholder: 'Section' },
    ],
    usernameField: 'username',
  });
}

// ==================== Generic Section Manager ====================
function setupSectionManager(config) {
  const homepage = document.querySelector('.homepage');
  const nav = document.querySelector(config.navSelector);
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

    // Show current section
    section.style.display = 'block';
    loadEntities(config);
  });

  addBtn.onclick = () => {
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
    columns: ['Username', 'Name', 'Section', 'Actions'],
    data: entities.map(entity => [
      entity.name,
      entity[config.usernameField],
      entity.section,
      gridjs.html(
        `<button onclick="window.viewEntity('${entity[config.usernameField]}', '${config.entityName}')">View</button>
         <button onclick="window.deleteEntity('${entity[config.usernameField]}', '${config.apiEndpoint}', '${config.entityName}')" class="button-secondary">Delete</button>`,
      ),
    ]),
    search: true,
    pagination: { limit: 100 },
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

  const response = await fetch(config.apiEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (response.ok) {
    document.getElementById(config.modalId).close();
    location.reload();
  } else {
    alert('Error saving entity');
  }
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
}

// ==================== Global Functions for Onclick Handlers ====================
window.viewEntity = (id, entityName) => {
  console.log(`View ${entityName}:`, id);
  // Implement view logic as needed
};

window.deleteEntity = deleteEntity;
