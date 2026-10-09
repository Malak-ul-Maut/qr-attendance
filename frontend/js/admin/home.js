// home.js - analytics: attendance trend, per-class / per-subject bars, low attendance, recent sessions.
import { $, h, api, createDataTable, downloadCsv, showToast, announce, errorText } from './core.js';

const pct = (present, total) => (total ? Math.round((present / total) * 100) : 0);
const level = value => (value >= 75 ? 'good' : value >= 60 ? 'mid' : 'low');
const LEVEL_LABEL = { good: 'On track', mid: 'Watch', low: 'Low' };
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const pctBadge = value =>
  h('span', { class: `badge badge-${{ good: 'success', mid: 'warning', low: 'danger' }[level(value)]} adm-pct adm-pct-${level(value)}`, text: `${value}%` });

const VIEW_NAMES = { master: 'Setup', enrollment: 'Face photos' };
function stat(label, value, note, goto, warn = null) {
  const tag = goto ? 'button' : 'div';
  return h(tag, { class: `card adm-stat${goto ? '' : ' adm-stat-static'}${warn ? ' adm-stat-warn' : ''}`, type: goto ? 'button' : false, 'data-goto': goto || false,
      onclick: goto ? () => document.dispatchEvent(new CustomEvent('admin:goto', { detail: goto })) : false },
    h('span', { class: 'adm-stat-label', text: label }),
    h('span', { class: 'adm-stat-value', text: value }),
    warn ? h('span', { class: 'adm-stat-alert', text: warn }) : null,
    h('span', { class: 'adm-stat-note' }, note, goto ? h('span', { class: 'visually-hidden', text: `. Opens ${VIEW_NAMES[goto]}.` }) : null),
    // Cards that open another tab show an arrow; plain figures do not
    goto ? h('span', { class: 'adm-stat-go', 'aria-hidden': 'true', text: '→' }) : null);
}

// Horizontal bars with the % written next to each one (colour is never the only signal).
// Lowest attendance first, so the rows that need attention are at the top. A row opens the matching sessions below.
function barList(mount, rows, empty, onOpen) {
  if (!rows.length) { announce(empty); return mount.replaceChildren(h('p', { class: 'adm-empty', text: empty })); }
  const sorted = [...rows].sort((a, b) => pct(a.present, a.total) - pct(b.present, b.total) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  mount.replaceChildren(
    h('ul', { class: 'adm-bars' },
      ...sorted.map(r => {
        const value = pct(r.present, r.total);
        const body = [
          h('span', { class: 'adm-bar-label', text: r.label }),
          h('span', { class: 'adm-bar-track', role: 'img', 'aria-label': `${r.label}: ${value}%` },
            h('span', { class: `adm-bar-fill adm-lvl-${level(value)}`, style: `width:${value}%` })),
          h('span', { class: 'adm-bar-value', text: `${value}%` })];
        return h('li', {}, onOpen
          ? h('button', { class: 'adm-bar-btn', type: 'button', 'aria-label': `${r.label}, ${value}% attendance. Show its sessions.`, onclick: () => onOpen(r) }, ...body)
          : body);
      })));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = iso => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
// Times are saved by SQLite in UTC ("2026-10-07 09:15:00"); show them in the viewer's own time zone
const toDate = sql => (sql ? new Date(String(sql).replace(' ', 'T') + 'Z') : null);
const timeOf = sql => { const d = toDate(sql); return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const shortDate = iso => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

// The chart is drawn at the width it is shown at, so text stays a real 12px on phones
// (a fixed 640px drawing shrinks to about 6px text on a 360px screen).
// Tap, drag or use the arrow keys to read the value of any day.
let trendState = null;
function trendChart(mount, daily) {
  trendState = { mount, daily };
  if (daily.length < 2) {
    mount.replaceChildren(h('p', { class: 'adm-empty', text: daily.length ? `Only one day of data so far: ${pct(daily[0].present, daily[0].total)}% present.` : 'No attendance recorded in this period yet.' }));
    return;
  }
  const W = Math.max(260, Math.round(mount.clientWidth || 640));
  const phone = W < 480;
  const H = phone ? 240 : 230, L = 34, R = 12, T = 22, B = 30;
  const n = daily.length;
  const x = i => L + (i * (W - L - R)) / (n - 1);
  const y = v => T + ((100 - v) * (H - T - B)) / 100;
  const value = i => pct(daily[i].present, daily[i].total);
  let selected = Number.isInteger(mount._sel) && mount._sel < n ? mount._sel : n - 1;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'adm-trend', role: 'img', tabindex: '0',
    'aria-label': `Daily attendance from ${daily[0].date} to ${daily.at(-1).date}. Use the left and right arrow keys to read each day.` });
  for (const g of [0, 25, 50, 75, 100]) {
    root.append(svg('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), class: g === 75 ? 'adm-grid adm-target' : 'adm-grid' }));
    const label = svg('text', { x: L - 6, y: y(g) + 4, class: 'adm-axis', 'text-anchor': 'end' });
    label.textContent = g;
    root.append(label);
  }
  const points = daily.map((d, i) => [x(i), y(value(i))]);
  root.append(svg('path', { d: `M${points.map(p => p.join(',')).join('L')}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: 'adm-area' }));
  root.append(svg('polyline', { points: points.map(p => p.join(',')).join(' '), class: 'adm-line' }));
  points.forEach(([cx, cy]) => root.append(svg('circle', { cx, cy, r: n > 40 ? 2 : phone && n > 20 ? 2.5 : 3.5, class: 'adm-dot' })));

  // X axis: as many dates as fit (about one per 64px), always including the first and the last
  const ticks = Math.min(n, Math.max(2, Math.floor((W - L - R) / 64) + 1));
  const tickIdx = [...new Set(Array.from({ length: ticks }, (_, k) => Math.round((k * (n - 1)) / (ticks - 1))))];
  tickIdx.forEach((i, k) => {
    const t = svg('text', { x: x(i), y: H - 8, class: 'adm-axis', 'text-anchor': k === 0 ? 'start' : k === tickIdx.length - 1 ? 'end' : 'middle' });
    t.textContent = shortDate(daily[i].date);
    root.append(t);
  });

  // Selected day: a guide line, a larger dot and the value above it
  const cursor = svg('line', { class: 'adm-cursor', y1: T, y2: y(0) });
  const mark = svg('circle', { r: 6, class: 'adm-dot-sel' });
  const pop = svg('text', { class: 'adm-pop', 'text-anchor': 'middle' });
  root.append(cursor, mark, pop);
  const hit = svg('rect', { x: L, y: 0, width: W - L - R, height: H - B + 6, class: 'adm-hit' });
  root.append(hit);
  const readout = h('p', { class: 'adm-trend-readout', role: 'status', 'aria-live': 'polite' });

  function select(i, announce = true) {
    selected = Math.max(0, Math.min(n - 1, i));
    mount._sel = selected;
    const d = daily[selected];
    const px = points[selected][0], py = points[selected][1];
    cursor.setAttribute('x1', px); cursor.setAttribute('x2', px);
    mark.setAttribute('cx', px); mark.setAttribute('cy', py);
    pop.setAttribute('x', Math.max(L + 14, Math.min(W - R - 14, px)));
    pop.setAttribute('y', Math.max(14, py - 12));
    pop.textContent = `${value(selected)}%`;
    if (announce) readout.textContent = `${longDate(d.date)}: ${value(selected)}% present (${d.present} of ${d.total} students)`;
  }
  const nearest = event => {
    const box = root.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    return Math.round(((px - L) / (W - L - R)) * (n - 1));
  };
  hit.addEventListener('pointerdown', event => select(nearest(event)));
  hit.addEventListener('pointermove', event => { if (event.pointerType === 'mouse' || event.buttons || event.pointerType === 'touch') select(nearest(event)); });
  root.addEventListener('keydown', event => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[event.key];
    if (!step) return;
    event.preventDefault();
    select(step === -n ? 0 : step === n ? n - 1 : selected + step);
  });
  select(selected);
  readout.textContent = `${longDate(daily[selected].date)}: ${value(selected)}% present (${daily[selected].present} of ${daily[selected].total} students). Tap or drag on the chart to read other days.`;
  mount.replaceChildren(root, readout, h('p', { class: 'adm-help', text: 'Dashed line marks the 75% requirement. Percent of enrolled students marked present each day.' }));
}

// Redraw when the width changes (rotating the phone, resizing the window)
let trendWidth = 0;
new ResizeObserver(() => {
  const mount = $('#trendChart');
  const width = Math.round(mount.clientWidth);
  if (!trendState || !width || width === trendWidth) return;
  trendWidth = width;
  trendChart(trendState.mount, trendState.daily);
}).observe($('#trendChart'));

const recentTable = createDataTable({
  mount: $('#recentSessions'),
  noun: 'session',
  pageSize: 8,
  emptyHint: 'Sessions started by faculty will appear here.',
  onRetry: () => load(),
  columns: [
    { key: 'date', label: 'Date', sortable: true, nowrap: true, get: r => r.date },
    { key: 'time', label: 'Time', sortable: true, nowrap: true, get: r => timeOf(r.startTime) || '–' },
    { key: 'subject', label: 'Subject', sortable: true, title: true, get: r => r.subject,
      render: (r, td) => td.append(h('button', { class: 'link-btn', type: 'button', text: r.subject, 'aria-label': `Open session: ${r.subject}, ${r.classes}, ${r.date}`, onclick: () => openSession(r.code) })) },
    { key: 'classes', label: 'Classroom', sortable: true, nowrap: true, get: r => r.classes },
    { key: 'faculty', label: 'Faculty', sortable: true, get: r => r.faculty },
    { key: 'method', label: 'Method', get: r => (r.method || '').toUpperCase() },
    { key: 'count', label: 'Present', num: true, get: r => `${r.present}/${r.total}` },
    { key: 'pct', label: 'Attendance', sortable: true, num: true, get: r => String(pct(r.present, r.total)).padStart(3, '0'),
      render: (r, td) => td.append(r.live ? h('span', { class: 'badge badge-info', text: 'Live now' }) : pctBadge(pct(r.present, r.total))) },
  ],
});

// ---- Below 75%: first 10, "View all" for the rest, and an export ----
let lowShowAll = false;
function renderLow(list, overall) {
  const box = $('#lowStudents');
  $('#exportLowBtn').disabled = !list.length;
  if (!list.length) {
    const text = overall.total ? 'Nobody is below 75% (students need 3+ sessions to be listed).' : 'No attendance in this period.';
    announce(text);
    return box.replaceChildren(h('p', { class: 'adm-empty', text }));
  }
  const shown = lowShowAll ? list : list.slice(0, 10);
  box.replaceChildren(
    h('p', { class: 'adm-help', text: `${list.length} student${list.length === 1 ? '' : 's'} below 75%, lowest first.` }),
    h('ul', { class: 'adm-activity adm-low-list' }, ...shown.map(s => h('li', {},
      h('button', { class: 'link-btn', type: 'button', text: s.name, 'aria-label': `${s.name}: open attendance history`, onclick: () => openStudent(s) }),
      h('span', { class: 'adm-when', text: `${s.roll || ''} · ${s.present}/${s.total}` }), pctBadge(pct(s.present, s.total))))),
    list.length > 10
      ? h('button', { class: 'btn btn-secondary btn-sm', id: 'lowMoreBtn', type: 'button', 'aria-expanded': String(lowShowAll), text: lowShowAll ? 'Show fewer' : `View all ${list.length}`,
          onclick: () => { lowShowAll = !lowShowAll; renderLow(list, overall); $('#lowMoreBtn')?.focus(); } })
      : null);
}

// ---- Clicking a class or subject bar narrows the recent sessions list to it ----
function filterRecent(label) {
  recentTable.setQuery(label);
  const chip = $('#recentFilter');
  chip.replaceChildren(`Showing sessions for ${label} `, h('button', { class: 'link-btn', type: 'button', text: 'Clear filter', onclick: () => { recentTable.setQuery(''); chip.hidden = true; } }));
  chip.hidden = false;
  $('#recentTitle').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---- Detail dialog: one session or one student ----
const detail = $('#detailDialog');
let detailExport = null;
$('#detailCloseBtn').addEventListener('click', () => detail.close());
$('#detailExportBtn').addEventListener('click', () => detailExport?.());
const stateRow = text => h('p', { class: 'adm-empty', text });
function openDetail(title, sub) {
  $('#detailTitle').textContent = title;
  $('#detailSub').textContent = sub;
  $('#detailBody').replaceChildren(stateRow('Loading…'));
  $('#detailExportBtn').hidden = true;
  detailExport = null;
  if (!detail.open) detail.showModal();
  $('#detailTitle').focus();
}
const presentBadge = yes => h('span', { class: `badge ${yes ? 'badge-success' : 'badge-danger'}`, text: yes ? '✓ Present' : 'Absent' });

async function openSession(code) {
  openDetail('Session details', 'Loading…');
  try {
    const s = await api(`/api/admin/analytics/session/${encodeURIComponent(code)}`);
    const present = s.students.filter(x => x.markedAt).length;
    $('#detailTitle').textContent = `${s.subject}${s.live ? ' · live now' : ''}`;
    $('#detailSub').textContent = `${longDate(s.date)}${timeOf(s.startTime) ? ' · started ' + timeOf(s.startTime) : ''} · ${s.faculty || 'No faculty'} · ${(s.method || '').toUpperCase()} · ${present} of ${s.students.length} present (${pct(present, s.students.length)}%)`;
    $('#detailBody').replaceChildren(s.students.length
      ? h('div', { class: 'adm-table-wrap adm-import-table', tabindex: '0', role: 'region', 'aria-label': 'Students in this session' },
        h('table', { class: 'adm-table' },
          h('thead', {}, h('tr', {}, ...['Name', 'Roll no.', 'Status', 'Marked at'].map(t => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, ...s.students.map(x => h('tr', {},
            h('td', {}, h('button', { class: 'link-btn', type: 'button', text: x.name, 'aria-label': `${x.name}: open attendance history`, onclick: () => openStudent(x) })),
            h('td', { text: x.roll || '' }), h('td', {}, presentBadge(Boolean(x.markedAt))), h('td', { text: timeOf(x.markedAt) || '–' }))))))
      : stateRow('No students were on the list for this session.'));
    $('#detailExportBtn').hidden = !s.students.length;
    detailExport = () => downloadCsv(`session-${s.date}-${s.subject}.csv`, ['Name', 'Roll number', 'Status', 'Marked at'],
      s.students.map(x => [x.name, x.roll, x.markedAt ? 'Present' : 'Absent', timeOf(x.markedAt)]));
  } catch (error) {
    $('#detailSub').textContent = '';
    $('#detailBody').replaceChildren(h('p', { class: 'alert alert-danger', role: 'alert', text: errorText(error) }));
  }
}

async function openStudent(student) {
  openDetail(student.name, 'Loading…');
  try {
    const r = await api(`/api/admin/analytics/student/${student.id}?days=${$('#homeRange').value}`);
    const present = r.sessions.filter(x => x.present).length;
    $('#detailTitle').textContent = `${r.student.name}${r.student.roll ? ` · ${r.student.roll}` : ''}`;
    $('#detailSub').textContent = r.sessions.length
      ? `${longDate(r.from)} to ${longDate(r.to)}: present in ${present} of ${r.sessions.length} sessions (${pct(present, r.sessions.length)}%)`
      : `No sessions between ${longDate(r.from)} and ${longDate(r.to)}.`;
    $('#detailBody').replaceChildren(r.sessions.length
      ? h('div', { class: 'adm-table-wrap adm-import-table', tabindex: '0', role: 'region', 'aria-label': 'Attendance history' },
        h('table', { class: 'adm-table' },
          h('thead', {}, h('tr', {}, ...['Date', 'Time', 'Subject', 'Faculty', 'Status'].map(t => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, ...r.sessions.map(x => h('tr', {},
            h('td', { text: longDate(x.date) }), h('td', { text: timeOf(x.startTime) || '–' }), h('td', { text: x.subject }), h('td', { text: x.faculty || '' }), h('td', {}, presentBadge(x.present)))))))
      : stateRow('Nothing recorded in this period.'));
    $('#detailExportBtn').hidden = !r.sessions.length;
    detailExport = () => downloadCsv(`history-${r.student.roll || r.student.id}.csv`, ['Date', 'Time', 'Subject', 'Faculty', 'Status'],
      r.sessions.map(x => [x.date, timeOf(x.startTime), x.subject, x.faculty, x.present ? 'Present' : 'Absent']));
  } catch (error) {
    $('#detailSub').textContent = '';
    $('#detailBody').replaceChildren(h('p', { class: 'alert alert-danger', role: 'alert', text: errorText(error) }));
  }
}

let data = null;

async function load() {
  $('#homeError').hidden = true;
  if (!data) recentTable.setLoading();
  try {
    data = await api(`/api/admin/analytics?days=${$('#homeRange').value}`);
  } catch (error) {
    // (An expired login never gets here: the request code sends the person to the login page.)
    $('#homeErrorText').textContent = error.code === 'network'
      ? 'Could not reach the server, so the numbers did not load.'
      : error.message && error.message !== 'Request failed.'
        ? `Could not load the numbers. ${error.message}`
        : 'Could not load the numbers.';
    $('#homeError').hidden = false;
    if (!data) recentTable.setError();
    return;
  }
  const { totals, overall, daily, byMethod, byClassroom, bySubject, lowStudents, recent } = data;
  const avg = pct(overall.present, overall.total);
  $('#homeStats').replaceChildren(
    stat('Students', totals.students, `${totals.classes} classes`, 'master'),
    stat('Faculty', totals.faculty, 'Manage faculty', 'master'),
    stat('Average attendance', overall.total ? `${avg}%` : '–', overall.total ? `${overall.sessions} sessions in range · target 75%` : `${overall.sessions} sessions in range`, null,
      overall.total && avg < 75 ? `▲ ${75 - avg} point${75 - avg === 1 ? '' : 's'} below the 75% target` : null),
    stat('Live now', totals.liveSessions, `${totals.sessionsToday} session${totals.sessionsToday === 1 ? '' : 's'} today`),
    stat('Photos approved', `${pct(totals.enrolled, totals.students)}%`, totals.pendingReview ? `${totals.pendingReview} waiting for review` : `${totals.students - totals.enrolled} not approved yet`, 'enrollment'),
  );
  trendChart($('#trendChart'), daily);
  $('#homeEnroll').replaceChildren(
    h('p', { class: 'adm-big', text: `${totals.enrolled} of ${totals.students}` }),
    h('p', { class: 'adm-help', text: 'students have uploaded their face photos.' }),
    h('span', { class: 'adm-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct(totals.enrolled, totals.students) },
      h('span', { style: `width:${pct(totals.enrolled, totals.students)}%` })),
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'See who is pending',
      onclick: () => document.dispatchEvent(new CustomEvent('admin:goto', { detail: 'enrollment' })) }));
  barList($('#byClassroom'), byClassroom, 'No attendance in this period.', r => filterRecent(r.label));
  barList($('#bySubject'), bySubject, 'No attendance in this period.', r => filterRecent(r.label));

  renderLow(lowStudents, overall);

  const totalSessions = byMethod.reduce((n, m) => n + m.sessions, 0);
  $('#byMethod').replaceChildren(
    totalSessions
      ? h('ul', { class: 'adm-bars' }, ...byMethod.map(m => h('li', {},
          h('span', { class: 'adm-bar-label', text: m.method.toUpperCase() }),
          h('span', { class: 'adm-bar-track' }, h('span', { class: 'adm-bar-fill adm-lvl-info', style: `width:${pct(m.sessions, totalSessions)}%` })),
          h('span', { class: 'adm-bar-value', text: m.sessions }))))
      : h('p', { class: 'adm-empty', text: 'No sessions in this period.' }));

  recentTable.setRows(recent);
  $('#exportSessionsBtn').disabled = !recent.length;
}

$('#exportLowBtn').addEventListener('click', () => {
  downloadCsv(`below-75-${new Date().toISOString().slice(0, 10)}.csv`, ['Name', 'Roll number', 'Present', 'Sessions', 'Attendance %'],
    data.lowStudents.map(s => [s.name, s.roll, s.present, s.total, pct(s.present, s.total)]));
  showToast(`${data.lowStudents.length} students exported.`, 'success');
});
$('#homeRange').addEventListener('change', () => { lowShowAll = false; $('#recentFilter').hidden = true; recentTable.setQuery(''); load(); });
$('#homeRetryBtn').addEventListener('click', load);
$('#exportSessionsBtn').addEventListener('click', () => {
  downloadCsv(`sessions-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Date', 'Time', 'Subject', 'Class', 'Faculty', 'Method', 'Present', 'Total', 'Attendance %'],
    data.recent.map(r => [r.date, timeOf(r.startTime), r.subject, r.classes, r.faculty, r.method, r.present, r.total, pct(r.present, r.total)]));
  showToast('CSV downloaded.', 'success');
});

export { load as loadHome };
