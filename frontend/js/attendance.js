// The Attendance tab: overall figure against the 75% rule, then each subject. Open a subject to see its dated
// records, one per period, newest first.
import { apiGet } from './api.js';
import { h } from './dom.js';
import { chipFor, fmtTime, shortPeriod } from './today-logic.js';
import { fmtDayDate } from './format.js';

const root = document.querySelector('#attendanceRoot');
let data = null;
let failed = null;

const RECORDS_STEP = 20;
const open = new Set(); // subject ids whose records are showing
const records = new Map(); // subject id -> { state: 'loading' | 'ok' | 'error', list, shown }

const STATUS_TEXT = {
  safe: 'You are above the 75% line.',
  close: 'You are close to the 75% line.',
  below: 'You are below the 75% line.',
};
// The ring is coloured by where the student stands. The line under it says the same in words.
const RING_STATUS = { safe: 'safe', close: 'close', below: 'below' };

export async function refresh() {
  const res = await apiGet('/api/student/attendance');
  if (res.ok) { data = res; failed = null; } else failed = res;
  records.clear(); // new marks may have arrived: read the records again when a subject is opened
  render();
}

function render() {
  if (failed && !data) {
    root.replaceChildren(h('div', { class: 'card empty', role: 'alert' },
      h('strong', { text: "Couldn't load your attendance." }),
      failed.status === 0 ? 'Check your Wi-Fi or mobile data.' : 'Please try again in a moment.',
      h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', onclick: refresh, text: 'Try again' }))));
    return;
  }
  if (!data) return;

  const o = data.overall;
  const none = o.percent === null;
  const ring = h('div', { class: `ring ring-${none ? 'none' : RING_STATUS[o.status]}`, role: 'img', 'aria-label': none ? 'No classes held yet' : `Overall attendance ${Math.round(o.percent)} percent` },
    h('span', { text: none ? '–' : `${Math.round(o.percent)}%` }));
  ring.style.setProperty('--pct', none ? 0 : o.percent);

  let guidance = 'No classes have been held yet.';
  if (!none) {
    guidance = STATUS_TEXT[o.status];
    if (o.status === 'below')
      guidance += ` Attend the next ${o.needToAttend} ${o.needToAttend === 1 ? 'class' : 'classes'} in a row to reach 75%.`;
    else
      guidance += o.canMiss > 0
        ? ` You can miss up to ${o.canMiss} more ${o.canMiss === 1 ? 'class' : 'classes'} and stay at 75%.`
        : ' Missing the next class would take you below it.';
  }

  const summary = h('div', { class: 'card summary' }, ring,
    h('div', {},
      h('h2', { text: 'Overall attendance' }),
      h('p', { text: none ? 'No classes yet.' : `Attended ${o.attended} of ${o.held} classes.` }),
      h('p', { class: `status-line status-${o.status}`, text: guidance })));

  const list = data.subjects.length
    ? h('ul', { class: 'list' }, data.subjects.map(subjectCard))
    : h('div', { class: 'card empty' }, h('strong', { text: 'No subjects yet' }), 'Subject-wise attendance shows here once classes have been held.');

  root.replaceChildren(summary, h('h2', { class: 'block-title', text: 'By subject' }), list);
  for (const id of open) showRecords(id); // open subjects stay open after a refresh
}

// ---------- one subject, and its records ----------
// An SVG has to be made in its own namespace, which h() does not do
function chevron() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ class: 'chevron', viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }))
    svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.append(path);
  return svg;
}

function subjectCard(s) {
  const id = s.subjectId;
  const isOpen = open.has(id);
  const toggle = h('button', { class: 'subject-toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': `rec-${id}`, 'data-focus-key': `subject-${id}`,
    onclick: () => toggleSubject(id) },
    h('span', { class: 'subject-name' }, s.name, h('br'), h('small', { text: [s.code, s.faculty].filter(Boolean).join(' · ') })),
    h('span', { class: 'subject-figure' },
      h('strong', { text: s.percent === null ? 'No classes yet' : `${Math.round(s.percent)}%` }),
      h('small', { text: s.held ? `${s.attended} of ${s.held}` : '' })),
    chevron());
  return h('li', { class: 'card subject-card', 'data-subject': id }, toggle, h('div', { class: 'records', id: `rec-${id}`, hidden: !isOpen }));
}

function toggleSubject(id) {
  const card = root.querySelector(`[data-subject="${id}"]`);
  const panel = card.querySelector('.records');
  const nowOpen = !open.has(id);
  if (nowOpen) open.add(id); else open.delete(id);
  card.querySelector('.subject-toggle').setAttribute('aria-expanded', String(nowOpen));
  panel.hidden = !nowOpen;
  if (nowOpen) showRecords(id);
}

async function showRecords(id) {
  const panel = root.querySelector(`[data-subject="${id}"] .records`);
  if (!panel) return;
  let entry = records.get(id);
  if (!entry) {
    entry = { state: 'loading', list: [], shown: RECORDS_STEP };
    records.set(id, entry);
    drawRecords(id, panel);
    const res = await apiGet(`/api/student/attendance?subject=${id}`);
    if (records.get(id) !== entry) return; // a refresh replaced it while we waited
    entry.state = res.ok ? 'ok' : 'error';
    entry.list = res.ok ? res.records || [] : [];
  }
  drawRecords(id, root.querySelector(`[data-subject="${id}"] .records`));
}

function drawRecords(id, panel) {
  if (!panel) return;
  const entry = records.get(id);
  if (entry.state === 'loading') return panel.replaceChildren(h('p', { class: 'meta', role: 'status', text: 'Loading...' }));
  if (entry.state === 'error')
    return panel.replaceChildren(h('p', { class: 'meta', role: 'alert' }, "Couldn't load these records. ",
      h('button', { class: 'link-btn', type: 'button', onclick: () => { records.delete(id); showRecords(id); }, text: 'Try again' })));
  if (!entry.list.length) return panel.replaceChildren(h('p', { class: 'meta', text: 'No classes held yet.' }));

  const present = entry.list.filter(r => r.status === 'present').length;
  const shown = entry.list.slice(0, entry.shown);
  // replaceChildren() would print a skipped (false) item as the word "false", so the list is filtered first
  panel.replaceChildren(...[
    h('p', { class: 'records-summary', text: `${present} present, ${entry.list.length - present} absent` }),
    h('ul', { class: 'record-list' }, shown.map(record)),
    entry.list.length > shown.length && h('button', { class: 'btn btn-secondary btn-sm', type: 'button',
      onclick: () => { entry.shown += RECORDS_STEP; drawRecords(id, panel); }, text: `Show ${Math.min(RECORDS_STEP, entry.list.length - shown.length)} more` }),
  ].filter(Boolean));
}

// One period: the date, which period and when, and whether the student was there
function record(r) {
  const chip = chipFor({ state: r.status === 'present' ? 'marked' : 'missed', markedAt: r.markedAt, markedMethod: r.method });
  return h('li', { class: 'record' },
    h('span', { class: 'record-date', text: fmtDayDate(r.date) }),
    h('span', { class: `chip chip-${chip.tone}` }, h('span', { 'aria-hidden': 'true', text: chip.icon }), ` ${chip.text}`),
    h('span', { class: 'meta record-when', text: `${shortPeriod(r.slot)} · ${fmtTime(r.startTime)} – ${fmtTime(r.endTime)}` }));
}

window.addEventListener('student:tab', ev => { if (ev.detail === 'attendance') refresh(); });
window.addEventListener('student:changed', () => { if (data) refresh(); });
window.addEventListener('student:schedule-changed', () => { if (data) refresh(); }); // marks change when a class is submitted (js/live.js)
