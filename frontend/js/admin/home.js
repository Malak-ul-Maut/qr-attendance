// home.js - analytics: attendance trend, per-class / per-subject bars, low attendance, recent sessions.
import { $, h, api, createDataTable, downloadCsv, showToast } from './core.js';

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
function stat(label, value, note, goto) {
  const tag = goto ? 'button' : 'div';
  return h(tag, { class: `card adm-stat${goto ? '' : ' adm-stat-static'}`, type: goto ? 'button' : false, 'data-goto': goto || false,
      onclick: goto ? () => document.dispatchEvent(new CustomEvent('admin:goto', { detail: goto })) : false },
    h('span', { class: 'adm-stat-label', text: label }),
    h('span', { class: 'adm-stat-value', text: value }),
    h('span', { class: 'adm-stat-note' }, note, goto ? h('span', { class: 'visually-hidden', text: `. Opens ${VIEW_NAMES[goto]}.` }) : null),
    // Cards that open another tab show an arrow; plain figures do not
    goto ? h('span', { class: 'adm-stat-go', 'aria-hidden': 'true', text: '→' }) : null);
}

// Horizontal bars with the % written next to each one (colour is never the only signal).
function barList(mount, rows, empty) {
  if (!rows.length) return mount.replaceChildren(h('p', { class: 'adm-empty', text: empty }));
  mount.replaceChildren(
    h('ul', { class: 'adm-bars' },
      ...rows.map(r => {
        const value = pct(r.present, r.total);
        return h('li', {},
          h('span', { class: 'adm-bar-label', text: r.label }),
          h('span', { class: 'adm-bar-track', role: 'img', 'aria-label': `${r.label}: ${value}%` },
            h('span', { class: `adm-bar-fill adm-lvl-${level(value)}`, style: `width:${value}%` })),
          h('span', { class: 'adm-bar-value', text: `${value}%` }));
      })));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = iso => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
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
    { key: 'subject', label: 'Subject', sortable: true, title: true, get: r => r.subject },
    { key: 'classes', label: 'Class', sortable: true, nowrap: true, get: r => r.classes },
    { key: 'faculty', label: 'Faculty', sortable: true, get: r => r.faculty },
    { key: 'method', label: 'Method', get: r => (r.method || '').toUpperCase() },
    { key: 'count', label: 'Present', num: true, get: r => `${r.present}/${r.total}` },
    { key: 'pct', label: 'Attendance', sortable: true, num: true, get: r => String(pct(r.present, r.total)).padStart(3, '0'),
      render: (r, td) => td.append(r.live ? h('span', { class: 'badge badge-info', text: 'Live now' }) : pctBadge(pct(r.present, r.total))) },
  ],
});

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
  const { totals, overall, daily, byMethod, byClass, bySubject, lowStudents, recent } = data;
  const avg = pct(overall.present, overall.total);
  $('#homeStats').replaceChildren(
    stat('Students', totals.students, `${totals.classes} classes`, 'master'),
    stat('Faculty', totals.faculty, 'Manage faculty', 'master'),
    stat('Average attendance', overall.total ? `${avg}%` : '–', `${overall.sessions} sessions in range`),
    stat('Live now', totals.liveSessions, `${totals.sessionsToday} session${totals.sessionsToday === 1 ? '' : 's'} today`),
    stat('Photos uploaded', `${pct(totals.enrolled, totals.students)}%`, `${totals.students - totals.enrolled} still pending`, 'enrollment'),
  );
  trendChart($('#trendChart'), daily);
  $('#homeEnroll').replaceChildren(
    h('p', { class: 'adm-big', text: `${totals.enrolled} of ${totals.students}` }),
    h('p', { class: 'adm-help', text: 'students have uploaded their face photos.' }),
    h('span', { class: 'adm-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct(totals.enrolled, totals.students) },
      h('span', { style: `width:${pct(totals.enrolled, totals.students)}%` })),
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'See who is pending',
      onclick: () => document.dispatchEvent(new CustomEvent('admin:goto', { detail: 'enrollment' })) }));
  barList($('#byClass'), byClass, 'No attendance in this period.');
  barList($('#bySubject'), bySubject, 'No attendance in this period.');

  $('#lowStudents').replaceChildren(
    lowStudents.length
      ? h('ul', { class: 'adm-activity' }, ...lowStudents.map(s => h('li', {},
          h('span', { text: s.name }), h('span', { class: 'adm-when', text: `${s.roll || ''} · ${s.present}/${s.total}` }), pctBadge(pct(s.present, s.total)))))
      : h('p', { class: 'adm-empty', text: overall.total ? 'Nobody is below 75% (students need 3+ sessions to be listed).' : 'No attendance in this period.' }));

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

$('#homeRange').addEventListener('change', load);
$('#homeRetryBtn').addEventListener('click', load);
$('#exportSessionsBtn').addEventListener('click', () => {
  downloadCsv(`sessions-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Date', 'Subject', 'Class', 'Faculty', 'Method', 'Present', 'Total', 'Attendance %'],
    data.recent.map(r => [r.date, r.subject, r.classes, r.faculty, r.method, r.present, r.total, pct(r.present, r.total)]));
  showToast('CSV downloaded.', 'success');
});

export { load as loadHome };
