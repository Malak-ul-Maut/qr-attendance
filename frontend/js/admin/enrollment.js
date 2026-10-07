// enrollment.js - who has uploaded their face photos and who has not.
import { $, h, api, createDataTable, askDelete, downloadCsv, fillSelect, showToast } from './core.js';

let students = [];
let loaded = false;

const table = createDataTable({
  mount: $('#enrollTable'),
  noun: 'student',
  emptyHint: 'Students appear here once they are added in Setup.',
  onRetry: () => load(),
  columns: [
    { key: 'name', label: 'Name', sortable: true, get: s => s.name },
    { key: 'roll', label: 'Roll no.', sortable: true, num: true, get: s => s.roll_number },
    { key: 'class', label: 'Class', sortable: true, get: s => s.classLabel },
    { key: 'status', label: 'Photos', sortable: true, get: s => (s.enrolled ? 'Uploaded' : 'Pending'),
      render: (s, td) => td.append(h('span', { class: `badge ${s.enrolled ? 'badge-success' : 'badge-warning'}`, text: s.enrolled ? '✓ Uploaded' : 'Pending' })) },
    { key: 'photos', label: 'Files', num: true, get: s => s.photos },
    { key: 'actions', label: 'Actions',
      render: (s, td) => s.enrolled && td.append(h('button', { class: 'btn btn-danger btn-sm', type: 'button', text: 'Reset', 'aria-label': `Reset face data of ${s.name}`,
        onclick: () => askDelete({ title: `Reset ${s.name}'s face data?`, text: 'The saved face template is removed and the student will need to upload photos again.',
          run: async () => { await api(`/api/admin/enrollment/${s.id}/reset`, { method: 'POST' }); showToast('Face data reset.', 'success'); load(); } }) })) },
  ],
});

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
let classFilter = '';

function applyFilters() {
  const status = $('#enrollStatus').value;
  table.setFilter(s => (!status || (status === 'done') === s.enrolled) && (!classFilter || String(s.classId) === classFilter));
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
  $('#enrollClasses').replaceChildren(...classes.map(c =>
    h('button', { class: `card adm-classbar${String(c.id) === classFilter && classFilter ? ' active' : ''}`, type: 'button', 'aria-pressed': String(c.id) === classFilter && classFilter !== '',
        onclick: () => { classFilter = classFilter === String(c.id) ? '' : String(c.id); $('#enrollClass').value = classFilter; render(); applyFilters(); } },
      h('span', { class: 'adm-bar-label', text: c.label }),
      h('span', { class: 'adm-progress' }, h('span', { style: `width:${pct(c.done, c.total)}%` })),
      h('span', { class: 'adm-help', text: `${c.done}/${c.total} uploaded` }))));
  const previous = $('#enrollClass').value;
  fillSelect($('#enrollClass'), classes.filter(c => c.id !== '').map(c => ({ value: c.id, label: c.label })), 'All classes');
  $('#enrollClass').value = previous;
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

$('#enrollRetryBtn').addEventListener('click', load);
$('#enrollSearch').addEventListener('input', e => table.setQuery(e.target.value));
$('#enrollStatus').addEventListener('change', applyFilters);
$('#enrollClass').addEventListener('change', e => { classFilter = e.target.value; render(); applyFilters(); });
$('#enrollExportBtn').addEventListener('click', () => {
  const pending = students.filter(s => !s.enrolled);
  downloadCsv(`pending-photos-${new Date().toISOString().slice(0, 10)}.csv`, ['Name', 'Roll number', 'Username', 'Class'],
    pending.map(s => [s.name, s.roll_number, s.username, s.classLabel]));
  showToast(`${pending.length} pending students exported.`, 'success');
});
