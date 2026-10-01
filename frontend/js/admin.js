import { getCurrentUser, logout } from '/utils/storage.js';

let currentConfig = null;
let editingId = null;
let studentMetadata = null;
let databaseTables = [];
let activeDatabaseTable = null;
let activeDatabasePage = 0;
let activeDatabaseSearch = '';
let databaseSearchTimer = null;
let editingDatabaseRow = null;

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

  setupDatabaseBrowser();
}

// ==================== Generic Section Manager ====================
function showSection(config) {
  // Hide all sections
  document.querySelector('.homepage').style.display = 'none';
  document.querySelector('.students').style.display = 'none';
  document.querySelector('.faculty').style.display = 'none';
  document.querySelector('.database').style.display = 'none';

  currentConfig = config;

  // Show current section
  document.querySelector(config.sectionSelector).style.display = 'block';
  loadEntities(config);
}

function setupDatabaseBrowser() {
  document
    .querySelector('.database-nav')
    .addEventListener('click', showDatabase);
  document
    .getElementById('databaseTableSelect')
    .addEventListener('change', event => {
      activeDatabaseTable = databaseTables.find(
        table => table.name === event.target.value,
      );
      activeDatabasePage = 0;
      refreshDatabaseRows();
    });
  document.getElementById('databaseSearch').addEventListener('input', event => {
    clearTimeout(databaseSearchTimer);
    databaseSearchTimer = setTimeout(() => {
      activeDatabaseSearch = event.target.value.trim();
      activeDatabasePage = 0;
      refreshDatabaseRows();
    }, 200);
  });
  document.getElementById('databaseAddRowBtn').addEventListener('click', () => {
    if (activeDatabaseTable) openDatabaseRowEditor();
  });
  document.getElementById('databasePreviousBtn').addEventListener('click', () => {
    if (activeDatabasePage > 0) {
      activeDatabasePage -= 1;
      refreshDatabaseRows();
    }
  });
  document.getElementById('databaseNextBtn').addEventListener('click', () => {
    activeDatabasePage += 1;
    refreshDatabaseRows();
  });
  document
    .getElementById('databaseCloseRowBtn')
    .addEventListener('click', () => {
      document.getElementById('databaseRowModal').close();
    });
  document
    .getElementById('databaseSaveRowBtn')
    .addEventListener('click', saveDatabaseRow);
}

async function showDatabase() {
  document.querySelector('.homepage').style.display = 'none';
  document.querySelector('.students').style.display = 'none';
  document.querySelector('.faculty').style.display = 'none';
  document.querySelector('.database').style.display = 'block';

  if (!getCurrentUser()?.adminToken) {
    setDatabaseStatus('Sign out and sign in again as admin to access the database.');
    return;
  }
  if (databaseTables.length) return refreshDatabaseRows();
  await loadDatabaseTables();
}

async function loadDatabaseTables() {
  setDatabaseStatus('Loading database tables...');
  try {
    const result = await databaseRequest('/api/admin/database/tables');
    databaseTables = result.tables;
    const select = document.getElementById('databaseTableSelect');
    select.replaceChildren();
    databaseTables.forEach(table => {
      const option = new Option(
        `${humanize(table.name)} (${table.rowCount})`,
        table.name,
      );
      select.add(option);
    });
    activeDatabaseTable = databaseTables[0] || null;
    if (activeDatabaseTable) select.value = activeDatabaseTable.name;
    document.getElementById('databaseAddRowBtn').disabled = !activeDatabaseTable;
    await refreshDatabaseRows();
  } catch (error) {
    setDatabaseStatus(error.message);
  }
}

async function refreshDatabaseRows() {
  if (!activeDatabaseTable) return;
  setDatabaseStatus('Loading rows...');
  const query = new URLSearchParams({
    page: String(activeDatabasePage),
    pageSize: '50',
    search: activeDatabaseSearch,
  });
  try {
    const result = await databaseRequest(
      `/api/admin/database/tables/${encodeURIComponent(activeDatabaseTable.name)}/rows?${query}`,
    );
    renderDatabaseRows(result.rows);
    const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
    document.getElementById('databasePageLabel').textContent =
      `${result.total} rows · page ${result.page + 1} of ${pageCount}`;
    document.getElementById('databasePreviousBtn').disabled = result.page === 0;
    document.getElementById('databaseNextBtn').disabled =
      (result.page + 1) * result.pageSize >= result.total;
    setDatabaseStatus('');
  } catch (error) {
    setDatabaseStatus(error.message);
  }
}

function renderDatabaseRows(rows) {
  const container = document.getElementById('databaseRows');
  const columns = activeDatabaseTable.columns.filter(column => !column.sensitive);
  const table = document.createElement('table');
  table.className = 'database-table';
  const header = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach(column => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = humanize(column.name);
    headerRow.append(cell);
  });
  const actionHeading = document.createElement('th');
  actionHeading.scope = 'col';
  actionHeading.textContent = 'Actions';
  headerRow.append(actionHeading);
  header.append(headerRow);
  table.append(header);

  const body = document.createElement('tbody');
  rows.forEach(row => {
    const rowElement = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('td');
      const value = row[column.name];
      cell.textContent = column.foreignKey
        ? referenceLabel(column.foreignKey.options, value)
        : value == null
          ? ''
          : String(value);
      rowElement.append(cell);
    });
    const actions = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openDatabaseRowEditor(row));
    actions.append(edit);
    rowElement.append(actions);
    body.append(rowElement);
  });
  table.append(body);
  container.replaceChildren(table);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'database-empty';
    empty.textContent = 'No rows found.';
    container.append(empty);
  }
}

function openDatabaseRowEditor(row = null) {
  const modal = document.getElementById('databaseRowModal');
  const fields = document.getElementById('databaseRowFields');
  const primaryKey = activeDatabaseTable.columns.find(column => column.primaryKey);
  fields.replaceChildren();
  editingDatabaseRow = row;
  document.getElementById('databaseRowModalTitle').textContent =
    `${row ? 'Edit' : 'Add'} ${humanize(activeDatabaseTable.name)} row`;

  activeDatabaseTable.columns.forEach(column => {
    if (!row && column.autoGenerated) return;
    const label = document.createElement('label');
    label.htmlFor = `database-field-${column.name}`;
    label.textContent = `${humanize(column.name)}${column.sensitive ? ' (write-only)' : ''}`;
    const control = createDatabaseField(column, row);
    control.id = label.htmlFor;
    control.dataset.column = column.name;
    control.required = column.required && !(row && column.sensitive);
    if (column.primaryKey && row) control.disabled = true;
    if (column.sensitive && row) {
      control.required = false;
      control.placeholder = 'Leave blank to keep the current value';
    }
    fields.append(label, control);
  });
  modal.showModal();
}

function createDatabaseField(column, row) {
  if (column.foreignKey) {
    const select = document.createElement('select');
    const placeholder = new Option(
      column.required ? 'Choose a reference' : 'None',
      '',
    );
    select.add(placeholder);
    column.foreignKey.options.forEach(option => {
      select.add(new Option(option.label, option.value));
    });
    if (row && row[column.name] != null) select.value = String(row[column.name]);
    return select;
  }

  const control = column.sensitive && column.name === 'descriptor'
    ? document.createElement('textarea')
    : document.createElement('input');
  if (control instanceof HTMLInputElement) {
    control.type = column.sensitive ? 'password' : /INT/i.test(column.type) ? 'number' : 'text';
    if (/INT/i.test(column.type)) control.step = '1';
  }
  if (row && !column.sensitive && row[column.name] != null) {
    control.value = String(row[column.name]);
  }
  return control;
}

async function saveDatabaseRow() {
  const values = {};
  document.querySelectorAll('#databaseRowFields [data-column]').forEach(control => {
    if (control.disabled) return;
    values[control.dataset.column] = control.value;
  });
  const isEditing = Boolean(editingDatabaseRow);
  const primaryKey = activeDatabaseTable.columns.find(column => column.primaryKey);
  const rowId = isEditing ? editingDatabaseRow[primaryKey.name] : null;
  const path = `/api/admin/database/tables/${encodeURIComponent(activeDatabaseTable.name)}/rows`;
  const url = isEditing ? `${path}/${encodeURIComponent(rowId)}` : path;
  const saveButton = document.getElementById('databaseSaveRowBtn');
  saveButton.disabled = true;
  try {
    await databaseRequest(url, {
      method: isEditing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    document.getElementById('databaseRowModal').close();
    await loadDatabaseTables();
  } catch (error) {
    setDatabaseStatus(error.message);
  } finally {
    saveButton.disabled = false;
  }
}

async function databaseRequest(url, options = {}) {
  const token = getCurrentUser()?.adminToken;
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token || ''}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      admin_login_required: 'Sign in again as admin to manage database rows.',
      invalid_admin_token: 'Your admin session is invalid. Sign in again.',
      expired_admin_token: 'Your admin session expired. Sign in again.',
      invalid_reference: 'Choose a valid value for each referenced field.',
      row_conflict_or_invalid_reference: 'The row conflicts with existing data or a reference is invalid.',
      required_value_missing: 'Complete all required fields.',
      primary_key_is_immutable: 'Primary keys cannot be changed.',
    };
    throw new Error(messages[result.error] || 'Database request failed.');
  }
  return result;
}

function referenceLabel(options, value) {
  if (value == null) return '';
  return options.find(option => String(option.value) === String(value))?.label || String(value);
}

function humanize(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function setDatabaseStatus(message) {
  document.getElementById('databaseStatus').textContent = message;
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
