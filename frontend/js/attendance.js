// The Attendance tab: overall figure against the 75% rule, then each subject.
// (Dated records, filters and the receipt arrive in the next stage.)
import { apiGet } from './api.js';
import { h } from './dom.js';

const root = document.querySelector('#attendanceRoot');
let data = null;
let failed = null;

const STATUS_TEXT = {
  safe: 'You are above the 75% line.',
  close: 'You are close to the 75% line.',
  below: 'You are below the 75% line.',
};

export async function refresh() {
  const res = await apiGet('/api/student/attendance');
  if (res.ok) { data = res; failed = null; } else failed = res;
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
  const ring = h('div', { class: 'ring', role: 'img', 'aria-label': none ? 'No classes held yet' : `Overall attendance ${Math.round(o.percent)} percent` },
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
    ? h('ul', { class: 'list' }, data.subjects.map(s => h('li', { class: 'card list-row' },
        h('span', {}, s.name, h('br'), h('small', { text: [s.code, s.faculty].filter(Boolean).join(' · ') })),
        h('span', { class: 'subject-figure' },
          h('strong', { text: s.percent === null ? 'No classes yet' : `${Math.round(s.percent)}%` }),
          h('small', { text: s.held ? `${s.attended} of ${s.held}` : '' })))))
    : h('div', { class: 'card empty' }, h('strong', { text: 'No subjects yet' }), 'Subject-wise attendance shows here once classes have been held.');

  root.replaceChildren(summary, h('h2', { class: 'block-title', text: 'By subject' }), list);
}

window.addEventListener('student:tab', ev => { if (ev.detail === 'attendance') refresh(); });
window.addEventListener('student:changed', () => { if (data) refresh(); });
