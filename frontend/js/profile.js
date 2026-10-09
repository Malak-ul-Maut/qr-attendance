// The Profile tab: who the student is, how their account is set up, password, log out.
// (Face photo enrolment arrives in a later stage.)
import { apiGet, apiPost } from './api.js';
import { h } from './dom.js';
import { classLabel } from './today-logic.js';
import { getCurrentUser, logout } from '../utils/storage.js';
import { showToast } from './ui.js';
import { session } from './state.js';
import { shotsFor } from './pose.js';

const root = document.querySelector('#profileRoot');
let me = null;
let face = null; // GET /face: photo count and date, once enrolled
let failed = null;
let passwordOpen = false; // the change-password form stays closed until the student asks for it

const PASSWORD_ERRORS = {
  wrong_password: 'The current password is not right.',
  password_too_short: 'Use at least 8 characters.',
  password_unchanged: 'The new password must be different from the current one.',
  password_is_default: 'Choose something other than the default password.',
  password_is_username: 'Your password cannot be your username.',
  password_is_roll_number: 'Your password cannot be your roll number.',
  network: 'No connection to the server. Try again.',
};

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
        row('Email', me.email), row('Phone', me.phone), row('Year of passing', me.yearOfPassing))),
    h('section', { class: 'card profile-card' },
      h('h2', { text: 'Your class' }),
      k ? h('dl', { class: 'facts' },
        row('Class', classLabel(k)), row('Course', k.courseName), row('Branch', k.branchName),
        row('Semester', k.semester), row('Section', k.section), row('Academic session', k.academicSession),
        row('Batch', k.batch), row('Home room', k.homeRoom), row('Class counsellor', k.counsellor))
        : h('p', { class: 'meta', text: "You're not assigned to a class yet. Contact the admin office." })),
    faceCard(),
    passwordCard(),
    h('section', { class: 'card profile-card' },
      h('h2', { text: 'Session' }),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => logout(), text: 'Log out' })));
}

function faceCard() {
  const body = [];
  if (me.faceStatus === 'pending') {
    body.push(
      h('p', {}, h('span', { class: 'chip chip-warning', text: 'Waiting for approval' }), ' Your photos are saved. The admin office will check them soon.'),
      h('p', { class: 'meta', text: 'QR attendance starts working once they are approved. Until then, ask your teacher to mark you present.' }));
  } else if (me.faceEnrolled) {
    const when = face?.enrolledAt ? new Date(face.enrolledAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    body.push(
      h('p', {}, h('span', { class: 'chip chip-success', text: '✓ Enrolled' }), ` Your face is set up for QR attendance${when ? `, saved on ${when}` : ''}${face?.photoCount ? ` (${face.photoCount} photos)` : ''}.`),
      h('p', { class: 'meta', text: 'Your photos are locked. If something changed, such as a new look, ask the admin office to reset them.' }),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => window.dispatchEvent(new CustomEvent('student:selftest')), text: 'Test my camera and lighting' }));
  } else {
    const glasses = h('input', { type: 'checkbox', id: 'wearsGlasses' });
    const blocked = me.mustChangePassword;
    body.push(
      me.faceStatus === 'rejected'
        ? h('p', { class: 'note note-warning', role: 'status', text: `Your last photos were rejected: ${me.faceRejectReason || 'please take them again'}. Take new ones below.` })
        : h('p', {}, h('span', { class: 'chip chip-warning', text: '! Not added yet' }), " You can't mark attendance until your face photos are added."),
      h('p', { class: 'meta', text: 'You will take 7 photos with the front camera, each from a slightly different angle, like the way a classroom camera sees you. It takes about two minutes.' }),
      h('ul', { class: 'photo-plan' }, shotsFor(false).map(s => h('li', { text: s.title }))),
      h('p', { class: 'meta', text: 'Sit somewhere well lit, facing the light. Take off any cap or mask. Do this by yourself, one person in view.' }),
      h('label', { class: 'check-row', for: 'wearsGlasses' }, glasses, 'I usually wear glasses (one extra photo without them)'),
      blocked && h('p', { class: 'note note-warning', text: 'Change your password first, then come back here.' }),
      h('button', { class: 'btn btn-primary', type: 'button', disabled: blocked, onclick: () => window.dispatchEvent(new CustomEvent('student:enrol', { detail: { wearsGlasses: glasses.checked } })), text: 'Start taking photos' }));
  }
  return h('section', { class: 'card profile-card' }, h('h2', { text: 'Face photos' }), ...body);
}

function passwordCard() {
  const msg = h('p', { class: 'field-msg err', role: 'alert', hidden: true });
  const field = (id, label, auto) => h('div', { class: 'field' },
    h('label', { for: id, text: label }),
    h('input', { class: 'input', id, type: 'password', autocomplete: auto, required: true }));
  const form = h('form', { novalidate: true },
    me.mustChangePassword && h('p', { class: 'note note-warning', text: 'You are still using the default password. Please change it.' }),
    field('pwCurrent', 'Current password', 'current-password'),
    field('pwNew', 'New password (at least 8 characters)', 'new-password'),
    field('pwConfirm', 'Repeat new password', 'new-password'),
    msg,
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn btn-primary', type: 'submit', text: 'Save new password' }),
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => setOpen(false), text: 'Cancel' })));

  // A student on the default password must change it, so the form starts open for them
  const startOpen = passwordOpen || me.mustChangePassword;
  form.hidden = !startOpen;
  const openButton = h('button', { class: 'btn btn-secondary', type: 'button', 'aria-expanded': String(startOpen), 'aria-controls': 'pwForm', onclick: () => setOpen(true), text: 'Change password' });
  form.id = 'pwForm';
  openButton.hidden = startOpen;
  function setOpen(open) {
    passwordOpen = open;
    form.hidden = !open;
    openButton.hidden = open;
    openButton.setAttribute('aria-expanded', String(open));
    if (open) form.querySelector('input')?.focus(); else { form.reset(); msg.hidden = true; openButton.focus(); }
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    msg.hidden = true;
    const v = id => form.querySelector(`#${id}`).value;
    const fail = text => { msg.textContent = text; msg.hidden = false; };
    if (!v('pwCurrent')) return fail('Enter your current password.');
    if (v('pwNew').length < 8) return fail(PASSWORD_ERRORS.password_too_short);
    if (v('pwNew') !== v('pwConfirm')) return fail('The two new passwords do not match.');

    const button = form.querySelector('button[type=submit]');
    button.setAttribute('aria-busy', 'true'); button.disabled = true;
    const res = await apiPost('/api/student/password', { currentPassword: v('pwCurrent'), newPassword: v('pwNew') });
    button.removeAttribute('aria-busy'); button.disabled = false;
    if (!res.ok) return fail(PASSWORD_ERRORS[res.error] || 'Could not change the password. Try again.');

    // Keep the saved sign-in in step, so the "Finish setting up" card clears.
    try {
      const user = getCurrentUser();
      if (user) localStorage.setItem('user', JSON.stringify({ ...user, mustChangePassword: false }));
    } catch { /* storage blocked: the server value still wins on the next load */ }
    showToast('Password changed.', 'success');
    form.reset();
    passwordOpen = false; // fold the form away again
    await refresh();
    window.dispatchEvent(new CustomEvent('student:changed'));
  });
  return h('section', { class: 'card profile-card' }, h('h2', { text: 'Password' }), openButton, form);
}

window.addEventListener('student:tab', ev => { if (ev.detail === 'profile') refresh(); });
window.addEventListener('student:changed', () => { if (me) refresh(); });
