// import.js - one CSV import dialog for students, faculty and timetable.
// The file is checked on the server first (nothing is saved), then imported on confirm.
import { $, h, api, parseCsv, downloadCsv, setBusy, setBox, errorText, showToast } from './core.js';

const KINDS = {
  students: {
    title: 'Import students',
    help: 'Required: name, roll_number, branch, semester, section. Optional: username (defaults to roll number), password (blank = a secure one is generated and offered as a download), college_email, phone_number, year_of_passing, batch, session, course. Existing students (same username or roll number) are updated.',
    header: ['name', 'roll_number', 'username', 'password', 'college_email', 'phone_number', 'branch', 'semester', 'section', 'batch', 'session'],
    sample: [['Asha Verma', '2301010001', '', '', 'asha@example.edu', '9876543210', 'CSE', '5', 'A', 'G1', '2026-2027 ODD']],
  },
  faculty: {
    title: 'Import faculty',
    help: 'Required: name. Optional: abbr (generated if blank), username (defaults to abbr), password (blank = a secure one is generated and offered as a download). Existing faculty (same username or abbr) are updated.',
    header: ['name', 'abbr', 'username', 'password'],
    sample: [['Mr. Rajat Kumar', 'RKU', 'rku', '']],
  },
  timetable: {
    title: 'Import timetable',
    help: 'One row per class per period. Required: branch, semester, section, day, period, subject. Optional: faculty (abbr), room (e.g. F-307), batch (G1/G2), session. Labs that take two periods need two rows. Rows with the same day, period, subject, faculty and room become one combined lecture. Rows are added to the timetable draft (nothing goes live until you publish it). Clashes with the draft are rejected.',
    header: ['branch', 'semester', 'section', 'day', 'period', 'subject', 'faculty', 'room', 'batch', 'valid_from', 'session'],
    sample: [
      ['CSE', '5', 'A', 'Monday', 'Period 1', 'DBMS', 'RKU', 'F-307', '', '', '2026-2027 ODD'],
      ['CSE', '5', 'A', 'Tuesday', 'Period 7', 'WTL', 'AMG', 'F-205', 'G2', '', '2026-2027 ODD'],
    ],
  },
};

const dialog = $('#importDialog');
let kind = null;
let rows = [];
let onDone = null;

function renderPreview(result) {
  const summary = h('p', { class: 'adm-import-summary' },
    h('span', { class: 'badge badge-success', text: `${result.created} new` }), ' ',
    h('span', { class: 'badge badge-info', text: `${result.updated} updated` }), ' ',
    h('span', { class: `badge ${result.errors ? 'badge-danger' : 'badge-success'}`, text: `${result.errors} with errors` }),
    result.errors ? h('span', { class: 'adm-help', text: ' Rows with errors are skipped.' }) : null);
  const shown = [...result.results].sort((a, b) => (b.status === 'error') - (a.status === 'error')).slice(0, 200);
  $('#importPreview').replaceChildren(summary,
    h('div', { class: 'adm-table-wrap adm-import-table', tabindex: '0', role: 'region', 'aria-label': 'Import preview' },
      h('table', { class: 'adm-table' },
        h('thead', {}, h('tr', {}, ...['Line', 'Result', 'Details'].map(t => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, ...shown.map(r => h('tr', {},
          h('td', { class: 'adm-num', text: r.line }),
          h('td', {}, h('span', { class: `badge ${{ create: 'badge-success', update: 'badge-info', error: 'badge-danger' }[r.status]}`, text: { create: '+ New', update: '↻ Update', error: '✕ Error' }[r.status] })),
          h('td', { text: r.message })))))),
    result.results.length > shown.length ? h('p', { class: 'adm-help', text: `Showing ${shown.length} of ${result.results.length} rows (errors first).` }) : null);
  $('#importCommitBtn').disabled = result.created + result.updated === 0;
  $('#importCommitBtn').textContent = `Import ${result.created + result.updated} row${result.created + result.updated === 1 ? '' : 's'}`;
}

function showCredentialList(credentials, summary) {
  const download = () => {
    downloadCsv(`new-${kind}-passwords-${new Date().toISOString().slice(0, 10)}.csv`, ['name', 'username', 'password'], credentials.map(c => [c.name, c.username, c.password]));
  };
  $('#importPreview').replaceChildren(
    h('p', { class: 'adm-big', text: summary }),
    h('p', { text: `${credentials.length} new account${credentials.length === 1 ? ' was' : 's were'} given a generated password. The passwords cannot be shown again, so download the list now and share each one privately.` }),
    h('button', { class: 'btn btn-primary', id: 'importPwBtn', type: 'button', text: 'Download passwords (CSV)', onclick: download }));
  $('#importCommitBtn').hidden = true;
  $('#importCancelBtn').textContent = 'Done';
  $('#importPwBtn').focus();
  showToast(summary, 'success');
}

export function openImport(which, done) {
  kind = which;
  onDone = done;
  rows = [];
  $('#importTitle').textContent = KINDS[which].title;
  $('#importHelp').textContent = KINDS[which].help;
  $('#importFile').value = '';
  $('#importFileName').textContent = 'No file chosen';
  $('#importPreview').replaceChildren();
  $('#importCommitBtn').disabled = true;
  $('#importCommitBtn').textContent = 'Import';
  $('#importCommitBtn').hidden = false;
  $('#importCancelBtn').textContent = 'Close';
  setBox('importError', '');
  dialog.showModal();
}

$('#importTemplateBtn').addEventListener('click', () =>
  downloadCsv(`${kind}-template.csv`, KINDS[kind].header, KINDS[kind].sample));
$('#importCancelBtn').addEventListener('click', () => dialog.close());

$('#importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  $('#importFileName').textContent = file.name;
  setBox('importError', '');
  $('#importPreview').replaceChildren(h('p', { class: 'adm-help', text: 'Checking file…' }));
  try {
    rows = parseCsv(await file.text());
    if (!rows.length) throw Object.assign(new Error('The file has no data rows. The first line must be the column names.'), { code: 'empty' });
    renderPreview(await api(`/api/admin/import/${kind}`, { method: 'POST', body: { rows, commit: false } }));
  } catch (error) {
    $('#importPreview').replaceChildren();
    $('#importCommitBtn').disabled = true;
    setBox('importError', errorText(error));
  }
});

$('#importCommitBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true);
  setBox('importError', '');
  try {
    const result = await api(`/api/admin/import/${kind}`, { method: 'POST', body: { rows, commit: true } });
    onDone?.();
    const summary = `Imported ${result.created + result.updated} rows${result.errors ? `, ${result.errors} skipped` : ''}.`;
    if (result.credentials?.length) {
      // New accounts got generated passwords. They are not stored anywhere readable,
      // so keep this dialog open until the admin has saved the list.
      showCredentialList(result.credentials, summary);
      return;
    }
    dialog.close();
    showToast(summary, result.errors ? 'info' : 'success');
  } catch (error) {
    setBox('importError', errorText(error));
  } finally {
    setBusy(button, false);
  }
});
