// The Profile tab: who the student is, how their account is set up, face photos, and the password row.
// Changing the password happens in the dialog in password-dialog.js.
import { apiGet, apiPost } from './api.js';
import { h } from './dom.js';
import { classLabel } from './today-logic.js';
import { session } from './state.js';
import { fmtDate } from './format.js';

const root = document.querySelector('#profileRoot');
let me = null;
let face = null; // GET /face: photo count and date, once enrolled
let failed = null;

export async function refresh() {
  const res = await apiGet('/api/student/me');
  if (res.ok) {
    me = res; session.me = res; failed = null;
    const f = await apiGet('/api/student/face');
    face = f.ok ? f : null;
  } else failed = res;
  render();
}

const row = (label, value) => value ? h('div', {}, h('dt', { text: label }), h('dd', { text: String(value) })) : null;

function render() {
  if (failed && !me) {
    root.replaceChildren(h('div', { class: 'card empty', role: 'alert' },
      h('strong', { text: "Couldn't load your profile." }), 'Please try again.',
      h('div', {}, h('button', { class: 'btn btn-primary', type: 'button', onclick: refresh, text: 'Try again' }))));
    return;
  }
  if (!me) return;
  const k = me.class;
  root.replaceChildren(
    h('section', { class: 'card profile-card' },
      h('h2', { text: 'You' }),
      h('dl', { class: 'facts' },
        row('Name', me.name), row('Roll number', me.rollNumber), row('Username', me.username),
        row('Email', me.email), row('Phone', me.phone), row('Year of passing', me.yearOfPassing)),
      passwordRow()),
    h('section', { class: 'card profile-card' },
      h('h2', { text: 'Your class' }),
      k ? h('dl', { class: 'facts' },
        row('Class', classLabel(k)), row('Course', k.courseName), row('Academic session', k.academicSession),
        row('Batch', k.batch), row('Home room', k.homeRoom), row('Class counsellor', k.counsellor))
        : h('p', { class: 'meta', text: "You're not assigned to a class yet. Contact the admin office." })),
    faceCard());
}

function faceCard() {
  const body = [];
  if (me.faceStatus === 'pending') {
    body.push(h('p', {}, h('span', { class: 'chip chip-warning', text: 'Waiting for approval' }), ' Your photos are saved. Until the admin office approves them, ask your teacher to mark you present.'));
  } else if (me.faceEnrolled) {
    const when = face?.enrolledAt ? fmtDate(face.enrolledAt) : null;
    body.push(
      h('p', {}, h('span', { class: 'chip chip-success', text: '✓ Enrolled' }), when ? ` Saved on ${when}. To change your photos, ask the admin office to reset them.` : ' To change your photos, ask the admin office to reset them.'),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => window.dispatchEvent(new CustomEvent('student:selftest')), text: 'Test my camera and lighting' }));
  } else {
    const glasses = h('input', { type: 'checkbox', id: 'wearsGlasses' });
    body.push(
      me.galleryEnrolled
        ? h('p', {}, h('span', { class: 'chip chip-success', text: '✓ Set up for classroom camera' }), ' Add photos below only if you also want QR attendance.')
        : me.faceStatus === 'rejected'
          ? h('p', { class: 'note note-warning', role: 'status', text: `Your last photos were rejected: ${me.faceRejectReason || 'please take them again'}.` })
          : h('p', {}, h('span', { class: 'chip chip-warning', text: '! Not added yet' }), ' Add your face photos to mark attendance.'),
      h('p', { class: 'meta', text: 'About two minutes. Good light on your face, nothing covering it, only you in view.' }),
      h('label', { class: 'check-row', for: 'wearsGlasses' }, glasses, 'I usually wear glasses'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => window.dispatchEvent(new CustomEvent('student:enrol', { detail: { wearsGlasses: glasses.checked } })), text: 'Start taking photos' }));
  }
  return h('section', { class: 'card profile-card' }, h('h2', { text: 'Face photos' }), ...body);
}

// One row: the label, a note when it still needs changing, and the button that opens the dialog
function passwordRow() {
  return h('div', { class: 'password-row' },
    h('div', { class: 'password-text' },
      h('strong', { text: 'Password' }),
      h('span', { class: me.mustChangePassword ? 'password-note warn' : 'password-note', text: me.mustChangePassword ? 'Still the default password' : 'Only you should know it' })),
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'data-focus-key': 'change-password',
      onclick: () => window.dispatchEvent(new CustomEvent('student:change-password', { detail: { first: false } })),
      text: 'Change password' }));
}

window.addEventListener('student:tab', ev => { if (ev.detail === 'profile') refresh(); });
window.addEventListener('student:changed', () => { if (me) refresh(); });
