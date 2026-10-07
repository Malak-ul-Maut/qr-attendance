// enrollment.js - who has uploaded their face photos and who has not.
import { $, h, api, createDataTable, askConfirm, downloadCsv, showToast, currentUser, errorText } from './core.js';

let students = [];
let loaded = false;

const RESET_REASONS = ['Photos were blurry or poor quality', 'Wrong person or wrong photos', 'Student asked to upload again', 'Appearance changed', 'Other'];

const table = createDataTable({
  mount: $('#enrollTable'),
  noun: 'student',
  emptyHint: 'Students appear here once they are added in Setup.',
  onRetry: () => load(),
  defaultSort: { key: 'status', dir: 1 }, // "Pending" sorts before "Uploaded", so who still needs to upload is on top
  columns: [
    { key: 'name', label: 'Name', sortable: true, get: s => s.name },
    { key: 'roll', label: 'Roll no.', sortable: true, num: true, get: s => s.roll_number },
    { key: 'class', label: 'Class', sortable: true, get: s => s.classLabel },
    { key: 'status', label: 'Photos', sortable: true, get: s => (s.enrolled ? 'Uploaded' : 'Pending'),
      render: (s, td) => td.append(h('span', { class: `badge ${s.enrolled ? 'badge-success' : 'badge-warning'}`, text: s.enrolled ? '✓ Uploaded' : 'Pending' })) },
    { key: 'photos', label: 'Photo files', help: 'Images saved for this student', num: true, get: s => s.photos,
      render: (s, td) => td.append(
        h('span', { text: String(s.photos) }), ' ',
        s.photos ? h('button', { class: 'link-btn', type: 'button', text: 'Preview', 'aria-label': `Preview ${s.photos} photo${s.photos === 1 ? '' : 's'} of ${s.name}`, onclick: () => openPhotos(s) }) : null) },
    { key: 'actions', label: 'Actions',
      render: (s, td) => s.enrolled && td.append(h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Reset', 'aria-label': `Reset face data of ${s.name}`,
        onclick: () => askConfirm({ title: `Reset ${s.name}'s face data?`, text: 'The saved face template is removed and the student will need to upload photos again. The photo files are kept.',
          confirmLabel: 'Reset', cancelLabel: 'Keep', reasons: RESET_REASONS, failText: 'Could not reset. Try again.',
          run: async reason => {
            try { await api(`/api/admin/enrollment/${s.id}/reset`, { method: 'POST', body: { reason } }); } catch (error) { throw Object.assign(error, { message: errorText(error) }); }
            showToast('Face data reset.', 'success');
            load();
          } }) })) },
  ],
});

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
let classFilter = '';

function applyFilters() {
  const status = $('#enrollStatus').value;
  table.setFilter(s => (!status || (status === 'done') === s.enrolled) && (!classFilter || String(s.classId) === classFilter));
  $('#enrollClassExportBtn').disabled = !classFilter;
  $('#enrollClassExportBtn').title = classFilter ? '' : 'Select a class below first';
}

function render() {
  const done = students.filter(s => s.enrolled).length;
  $('#enrollSummary').replaceChildren(
    h('p', { class: 'adm-big', text: `${done} of ${students.length} students have uploaded photos` }),
    h('span', { class: 'adm-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct(done, students.length) },
      h('span', { style: `width:${pct(done, students.length)}%` })),
    h('p', { class: 'adm-help', text: `${students.length - done} remaining · ${pct(done, students.length)}% complete` }));

  const byClass = new Map();
  for (const s of students) {
    const key = s.classId ?? '';
    const c = byClass.get(key) || { id: key, label: s.classLabel || 'No class', total: 0, done: 0 };
    c.total++;
    if (s.enrolled) c.done++;
    byClass.set(key, c);
  }
  const classes = [...byClass.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  // The class cards are the one class filter (there is no separate dropdown)
  $('#enrollClasses').replaceChildren(...classes.map(c => {
    const on = classFilter !== '' && String(c.id) === classFilter;
    return h('button', { class: `card adm-classbar${on ? ' active' : ''}`, type: 'button', 'aria-pressed': String(on), 'data-class': c.id,
      onclick: () => {
        classFilter = classFilter === String(c.id) ? '' : String(c.id);
        render();
        applyFilters();
        $('#enrollClasses').querySelector(`[data-class="${c.id}"]`)?.focus(); // the cards were redrawn, keep keyboard focus on the one used
      } },
      h('span', { class: 'adm-bar-label', text: c.label }),
      h('span', { class: 'adm-progress' }, h('span', { style: `width:${pct(c.done, c.total)}%` })),
      h('span', { class: 'adm-help', text: `${c.done}/${c.total} uploaded` }));
  }));
  $('#enrollExportBtn').disabled = done === students.length;
}

export async function loadEnrollment() {
  $('#enrollError').hidden = true;
  if (!loaded) table.setLoading();
  try {
    ({ students } = await api('/api/admin/enrollment'));
    loaded = true;
    table.setRows(students);
    render();
    applyFilters();
  } catch {
    $('#enrollError').hidden = false;
    if (!loaded) table.setError();
  }
}
const load = loadEnrollment;

// ---------------- photo preview ----------------
const photoDialog = $('#photoDialog');
let objectUrls = [];
const freePhotos = () => { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; };
photoDialog.addEventListener('close', freePhotos);
$('#photoCloseBtn').addEventListener('click', () => photoDialog.close());

// Photos need the admin token, which an <img src> cannot send, so each file is fetched and shown from memory
async function fetchPhoto(id, file) {
  const response = await fetch(`/api/admin/enrollment/${id}/photos/${encodeURIComponent(file)}`, { headers: { Authorization: `Bearer ${currentUser.adminToken || ''}` } });
  if (!response.ok) throw new Error('not available');
  const url = URL.createObjectURL(await response.blob());
  objectUrls.push(url);
  return url;
}
async function openPhotos(s) {
  freePhotos();
  $('#photoTitle').textContent = `${s.name}'s photos`;
  $('#photoSub').textContent = `${s.roll_number || ''}${s.classLabel ? ` · ${s.classLabel}` : ''} · ${s.enrolled ? 'face template saved' : 'no face template yet'}. These files are what the face template is built from.`;
  $('#photoGrid').replaceChildren(h('p', { class: 'adm-empty', text: 'Loading photos…' }));
  photoDialog.showModal();
  $('#photoTitle').focus();
  try {
    const { files } = await api(`/api/admin/enrollment/${s.id}/photos`);
    if (!files.length) return $('#photoGrid').replaceChildren(h('p', { class: 'adm-empty', text: 'No photo files were found for this student.' }));
    const figures = files.map((file, i) => h('figure', { class: 'adm-photo' }, h('span', { class: 'adm-photo-ph', text: '…' }), h('figcaption', { text: `Photo ${i + 1}` })));
    $('#photoGrid').replaceChildren(...figures);
    await Promise.all(files.map(async (file, i) => {
      try {
        const url = await fetchPhoto(s.id, file);
        figures[i].firstChild.replaceWith(h('img', { src: url, alt: `${s.name}, photo ${i + 1} of ${files.length}`, loading: 'lazy' }));
      } catch {
        figures[i].firstChild.textContent = 'Could not load';
      }
    }));
  } catch (error) {
    $('#photoGrid').replaceChildren(h('p', { class: 'alert alert-danger', role: 'alert', text: errorText(error) }));
  }
}

$('#enrollRetryBtn').addEventListener('click', load);
$('#enrollSearch').addEventListener('input', e => table.setQuery(e.target.value));
$('#enrollStatus').addEventListener('change', applyFilters);
$('#enrollExportBtn').addEventListener('click', () => {
  const pending = students.filter(s => !s.enrolled);
  downloadCsv(`pending-photos-${new Date().toISOString().slice(0, 10)}.csv`, ['Name', 'Roll number', 'Username', 'Class'],
    pending.map(s => [s.name, s.roll_number, s.username, s.classLabel]));
  showToast(`${pending.length} pending students exported.`, 'success');
});
$('#enrollClassExportBtn').addEventListener('click', () => {
  const inClass = students.filter(s => String(s.classId ?? '') === classFilter);
  const label = inClass[0]?.classLabel || 'class';
  downloadCsv(`photos-${label.replaceAll(' ', '-')}-${new Date().toISOString().slice(0, 10)}.csv`, ['Name', 'Roll number', 'Username', 'Class', 'Photos', 'Photo files'],
    inClass.map(s => [s.name, s.roll_number, s.username, s.classLabel, s.enrolled ? 'Uploaded' : 'Pending', s.photos]));
  showToast(`${inClass.length} students in ${label} exported.`, 'success');
});
