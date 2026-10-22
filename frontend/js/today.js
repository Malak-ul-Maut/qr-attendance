// The Today tab: what is on now, what is next, and what the student can do about it.
// The server decides each period's state from its own clock; this file only draws it.
import { apiGet } from './api.js';
import { h } from './dom.js';
import { session } from './state.js';
import { fmtDayMonth } from './format.js';
import {
  chipFor, classLabel, countdownText, fmtTime, greetingFor, groupRows, groupState,
  lunchBetween, minutesUntil, pickNow, toMin,
} from './today-logic.js';

// Polling is the biggest source of requests from an open tab, so it is slow and cheap:
//  - only /schedule is polled; /me (rarely changes) is re-read after ME_MAX_AGE_MS, or when something edits it
//  - once a minute, or every 20 s while a class is waiting for the teacher to open attendance
//  - nothing while the tab is hidden, and a focus/tab switch is ignored if we fetched in the last 10 s
const POLL_MS = 60000;
const POLL_WAITING_MS = 20000;
const ME_MAX_AGE_MS = 5 * 60000;
const MIN_GAP_MS = 10000;
const root = document.querySelector('#todayRoot');
const greetingEl = document.querySelector('#todayGreeting');
const subEl = document.querySelector('#todaySub');

let me = null;
let schedule = null; // last good /schedule response (today)
let week = null; // last good /schedule?week=1 response
let mode = 'today'; // 'today' | 'week'
let meFetchedAt = 0; // performance.now() of the last good /me
let fetchedAt = 0; // performance.now() of the last good fetch, so countdowns keep moving
let stale = null; // { at: 'HH:MM' } when the last refresh failed
let loadError = null;
let loading = false;
let lastSignature = '';

// First sign-in with the default password: send the student to Profile once, so the change is the first thing they do.
let forcedOnce = false;
function forcePasswordChange() {
  if (forcedOnce || !me?.mustChangePassword) return;
  forcedOnce = true;
  window.dispatchEvent(new CustomEvent('student:goto', { detail: 'profile' }));
}

// ---------- loading ----------
export async function refresh({ forceMe = false } = {}) {
  if (loading) return;
  loading = true;
  const needMe = forceMe || !me || performance.now() - meFetchedAt > ME_MAX_AGE_MS;
  try {
    const [meRes, schedRes] = await Promise.all([
      needMe ? apiGet('/api/student/me') : Promise.resolve({ ...me, ok: true }),
      mode === 'week'
        ? apiGet('/api/student/schedule?week=1')
        : apiGet('/api/student/schedule'),
    ]);
    if (meRes.ok && schedRes.ok) {
      me = meRes;
      session.me = meRes;
      if (needMe) meFetchedAt = performance.now();
      forcePasswordChange();
      if (mode === 'week') week = schedRes;
      else schedule = schedRes;
      fetchedAt = performance.now();
      stale = null;
      loadError = null;
    } else if ((schedRes.status === 0 || meRes.status === 0) && (schedule || week)) {
      // Offline blip: keep showing what we have, and say how old it is.
      stale = { at: nowTimeEstimate() };
    } else {
      loadError = schedRes.ok ? meRes : schedRes;
    }
  } finally {
    loading = false;
  }
  render();
}

// Server-local 'HH:MM' now, advanced by the time since the last fetch.
function nowTimeEstimate() {
  const base = (schedule || week)?.nowTime;
  if (!base) return '00:00';
  const minutes = (toMin(base) + Math.floor((performance.now() - fetchedAt) / 60000)) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// ---------- rendering ----------
function render() {
  const data = mode === 'week' ? week : schedule;
  // Skip redrawing when nothing changed, so focus and scroll are not lost every 15 seconds.
  const signature = JSON.stringify([mode, me, data && { ...data, serverNow: 0, nowTime: 0 }, stale, loadError]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const focused = document.activeElement?.dataset?.focusKey;
  root.replaceChildren(...build(data));
  root.removeAttribute('aria-busy');
  if (focused) root.querySelector(`[data-focus-key="${focused}"]`)?.focus();
  tick();
}

function build(data) {
  if (loadError) return [errorCard()];
  if (!data || !me) return [skeleton()];

  const nodes = [];
  setHeader(data);

  if (!data.assigned) {
    nodes.push(h('div', { class: 'card empty', role: 'status' },
      h('strong', { text: "You're not assigned to a class yet." }),
      'Contact the admin office so they can add you to your class.'));
    return nodes;
  }

  nodes.push(...alerts(data));
  nodes.push(modeSwitch());
  nodes.push(...(mode === 'week' ? buildWeek(data) : buildToday(data)));
  return nodes;
}

function setHeader(data) {
  const first = String(me.name || '').trim().split(/\s+/)[0] || 'there';
  greetingEl.textContent = `${greetingFor(data.nowTime || '09:00')}, ${first}`;
  const dateText = fmtDayMonth(data.today, 'long');
  const k = data.class;
  const bits = k ? [classLabel(k), k.homeRoom ? `Room ${k.homeRoom}` : null, k.batch ? `Batch ${k.batch}` : null] : [];
  subEl.replaceChildren(
    h('span', { text: dateText }),
    ...bits.filter(Boolean).map(b => h('span', { class: 'class-chip', text: b })),
  );
}

function alerts(data) {
  const out = [];
  if (stale)
    out.push(h('p', { class: 'note note-warning', role: 'status', text: `Couldn't refresh. Showing the last update from ${fmtTime(stale.at)}.` }));
  // A student whose photos were added by hand is already known to the CCTV camera, so is not nagged to enrol.
  const needsFace = !me.faceEnrolled && !me.galleryEnrolled;
  if (me.mustChangePassword || needsFace) {
    const items = [];
    if (me.mustChangePassword) items.push(['Change your password', 'You are still using the default one.']);
    if (needsFace) items.push(me.faceStatus === 'pending' ? ['Face photos waiting for approval', 'The admin office is checking them. Until then, ask your teacher to mark you.']
      : me.faceStatus === 'rejected' ? ['Face photos were rejected', `${me.faceRejectReason || 'Please take them again.'} Take new photos in Profile.`]
      : ['Add your face photos', "You can't mark attendance until your face is enrolled."]);
    out.push(h('section', { class: 'card checklist', 'aria-labelledby': 'setupTitle' },
      h('h2', { id: 'setupTitle', text: 'Finish setting up' }),
      h('ul', {}, items.map(([title, why]) => h('li', {}, h('strong', { text: title }), h('span', { text: why })))),
      h('button', { class: 'btn btn-secondary', type: 'button', 'data-focus-key': 'goto-profile', onclick: () => window.dispatchEvent(new CustomEvent('student:goto', { detail: 'profile' })), text: needsFace ? (me.faceStatus === 'pending' ? 'View status' : 'Add face photos') : 'Change password' })));
  }
  if (data.timetableChange)
    out.push(h('p', { class: 'note note-info', text: `Your timetable changes on ${formatDay(data.timetableChange.startsOn)}.` }));
  return out;
}

function modeSwitch() {
  const mk = (value, label) => h('label', {},
    h('input', { type: 'radio', name: 'todayMode', value, 'data-focus-key': `mode-${value}`, checked: mode === value, onchange: () => setMode(value) }),
    h('span', { text: label }));
  return h('fieldset', { class: 'segmented mode-switch' }, h('legend', { class: 'visually-hidden', text: 'View' }), mk('today', 'Today'), mk('week', 'Week'));
}

async function setMode(next) {
  if (mode === next) return;
  mode = next;
  lastSignature = '';
  render(); // shows what we already have, if anything
  await refresh();
}

// ----- Today view -----
function buildToday(data) {
  const rows = data.rows;
  if (!rows.length) {
    const next = data.nextClassDate ? ` Your next class day is ${formatDay(data.nextClassDate)}.` : '';
    return [h('div', { class: 'card empty', role: 'status' }, h('strong', { text: 'No classes today' }), `Enjoy the day.${next}`)];
  }
  const groups = groupRows(rows);
  const nowIndex = pickNow(groups);
  const nodes = [];

  if (nowIndex === -1)
    nodes.push(h('p', { class: 'note note-info', text: "That's all your classes for today." }));
  else
    nodes.push(h('h2', { class: 'block-title', text: groupState(groups[nowIndex]) === 'upcoming' ? 'Next up' : 'Now' }), card(groups[nowIndex], data, true));

  const rest = groups.filter((_, i) => i !== nowIndex);
  if (rest.length) {
    nodes.push(h('h2', { class: 'block-title', text: nowIndex === -1 ? 'Today' : 'Rest of the day' }));
    const list = h('ol', { class: 'class-list' });
    groups.forEach((g, i) => {
      if (i === nowIndex) return;
      const prev = groups[i - 1];
      if (prev && lunchBetween(prev, g))
        list.append(h('li', { class: 'lunch', 'aria-label': 'Lunch break', text: `Lunch · ${fmtTime(prev.endTime)} – ${fmtTime(g.startTime)}` }));
      list.append(h('li', {}, card(g, data, false)));
    });
    nodes.push(list);
  }
  return nodes;
}

function card(group, data, featured) {
  const state = groupState(group);
  const timeRange = `${fmtTime(group.startTime)} – ${fmtTime(group.endTime)}`;
  const details = [group.room ? `Room ${group.room}` : null, group.faculty, group.forBatch ? 'Lab batch' : null].filter(Boolean).join(' · ');

  const chips = h('ul', { class: 'chips' }, group.periods.map(p => {
    const chip = chipFor(p);
    const label = group.periods.length > 1 ? `${p.slot}: ` : '';
    return h('li', { class: `chip chip-${chip.tone}` }, h('span', { 'aria-hidden': 'true', text: chip.icon }), ` ${label}${chip.text}`);
  }));

  const el = h('article', { class: `card class-card state-${state}${featured ? ' featured' : ''}`, 'aria-label': `${group.subject.name}, ${timeRange}` },
    h('div', { class: 'class-head' },
      h('h3', { text: group.subject.name }),
      h('span', { class: 'time', text: timeRange })),
    details && h('p', { class: 'meta', text: details }),
    chips,
    action(group, state, data));
  return el;
}

// The one thing the student can do on this card.
function action(group, state, data) {
  if (state === 'open_qr')
    return h('button', { class: 'btn btn-primary scan-btn', type: 'button', 'data-focus-key': `scan-${group.periods[0].timetableId}`,
      onclick: ev => window.dispatchEvent(new CustomEvent('student:scan', { detail: { subject: group.subject.name, button: ev.currentTarget } })) },
      h('img', { src: 'icons/generate-qr.svg', alt: '' }), h('span', { text: 'Scan QR' }));
  if (state === 'open_camera')
    return h('p', { class: 'hint', text: 'Stay seated. The classroom camera is marking attendance.' });
  if (state === 'waiting')
    return h('p', { class: 'hint', text: "Your teacher hasn't opened attendance yet. This page updates by itself." });
  if (state === 'upcoming')
    return h('p', { class: 'hint countdown', 'data-start': group.startTime, text: countdownText(minutesUntil(group.startTime, nowTimeEstimate())) });
  if (state === 'batch_pending')
    return h('p', { class: 'hint', text: "Your lab batch isn't assigned yet. Ask your class teacher." });
  if (state === 'not_on_roster')
    return h('p', { class: 'hint', text: "You're not on this session's list. Tell your teacher." });
  return null;
}

// ----- Week view (read-only) -----
function buildWeek(data) {
  const out = [];
  for (const day of data.days) {
    const isToday = day.date === data.today;
    const groups = groupRows(day.rows);
    out.push(h('section', { class: `card week-day${isToday ? ' is-today' : ''}`, 'aria-labelledby': `wd-${day.date}` },
      h('h2', { id: `wd-${day.date}` }, formatDay(day.date), isToday && h('span', { class: 'chip chip-info', text: 'Today' })),
      groups.length
        ? h('ul', { class: 'week-list' }, groups.map((g, i) => {
            const prev = groups[i - 1];
            return h('li', {},
              prev && lunchBetween(prev, g) && h('span', { class: 'lunch-line', text: 'Lunch' }),
              h('span', { class: 'time', text: `${fmtTime(g.startTime)} – ${fmtTime(g.endTime)}` }),
              h('span', { class: 'subject', text: g.subject.name }),
              g.room && h('span', { class: 'meta', text: `Room ${g.room}` }),
              weekChip(g));
          }))
        : h('p', { class: 'meta', text: 'No classes' })));
  }
  return out;
}

// Past and running periods show their outcome; future ones show nothing extra.
function weekChip(group) {
  const state = groupState(group);
  if (['upcoming', 'not_held'].includes(state) && group.periods.every(p => p.state === state)) return null;
  const chip = chipFor(group.periods.find(p => p.state === state) || group.periods[0]);
  return h('span', { class: `chip chip-${chip.tone}` }, h('span', { 'aria-hidden': 'true', text: chip.icon }), ` ${chip.text}`);
}

const formatDay = iso => fmtDayMonth(iso);

function skeleton() {
  return h('div', { class: 'skeleton-stack', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton', style: 'height:7rem' }),
    h('div', { class: 'skeleton', style: 'height:5rem' }),
    h('div', { class: 'skeleton', style: 'height:5rem' }));
}

function errorCard() {
  return h('div', { class: 'card empty', role: 'alert' },
    h('strong', { text: "Couldn't load your classes." }),
    loadError?.status === 0 ? 'Check your Wi-Fi or mobile data.' : 'Please try again in a moment.',
    h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { loadError = null; lastSignature = ''; refresh(); }, text: 'Try again' })));
}

// Keeps "Starts in 25 min" moving between fetches.
function tick() {
  const now = nowTimeEstimate();
  root.querySelectorAll('.countdown').forEach(el => {
    el.textContent = countdownText(minutesUntil(el.dataset.start, now));
  });
}

// ---------- when to refresh ----------
const todayVisible = () => !document.hidden && !document.querySelector('#view-today')?.hidden;

function nextDelay() {
  const rows = [...(schedule?.rows || []), ...(week?.days?.flatMap(d => d.rows) || [])];
  return mode === 'today' && rows.some(r => r.state === 'waiting') ? POLL_WAITING_MS : POLL_MS;
}
// A timer chain (not setInterval) so the delay can change as the day goes on.
function schedulePoll() {
  setTimeout(() => {
    if (todayVisible()) refresh();
    schedulePoll();
  }, nextDelay());
}
schedulePoll();
setInterval(() => { if (todayVisible()) tick(); }, 30000);

// Coming back to the page: refresh, unless we only just did.
const refreshIfStale = () => { if (todayVisible() && performance.now() - fetchedAt > MIN_GAP_MS) refresh(); };
document.addEventListener('visibilitychange', refreshIfStale);
window.addEventListener('focus', refreshIfStale);
window.addEventListener('student:tab', ev => { if (ev.detail === 'today') refreshIfStale(); });
window.addEventListener('student:changed', () => refresh({ forceMe: true })); // after marking attendance or editing the profile

root.setAttribute('aria-busy', 'true');
render();
refresh().then(() => window.dispatchEvent(new CustomEvent('student:ready')));
