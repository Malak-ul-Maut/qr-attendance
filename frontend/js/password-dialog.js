// The change-password dialog. One copy for the whole student page: the avatar menu, the Profile tab, the
// "Finish setting up" card and the first sign-in all ask for it with the `student:change-password` event.
//   window.dispatchEvent(new CustomEvent('student:change-password', { detail: { first: true } }))
// `first` adds the "still the default password" line and a Later button instead of Cancel.
import { apiPost } from './api.js';
import { getCurrentUser } from '../utils/storage.js';
import { session } from './state.js';
import { showToast } from './ui.js';

const dialog = document.querySelector('#password-dialog');
const form = document.querySelector('#pwForm');
const current = document.querySelector('#pwCurrent');
const next = document.querySelector('#pwNew');
const confirm = document.querySelector('#pwConfirm');
const saveBtn = document.querySelector('#pwSave');
const laterBtn = document.querySelector('#pwLater');
const errorEl = document.querySelector('#pwError');
const currentMsg = document.querySelector('#pwCurrentMsg');

const DEFAULT_PASSWORD = 'password'; // the server refuses it too; this only lets the checklist say so first

const SERVER_ERRORS = {
  wrong_password: 'The current password is not right.',
  password_too_short: 'Use at least 8 characters.',
  password_unchanged: 'The new password must be different from the current one.',
  password_is_default: 'Choose something other than the default password.',
  password_is_username: 'Your password cannot be your username.',
  password_is_roll_number: 'Your password cannot be your roll number.',
  network: 'No connection to the server. Try again.',
  timeout: 'The server is slow to answer. Try again.',
};

const EYE_ON =
  '<svg class="eye-on" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg class="eye-off" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" hidden><path d="M3 3l18 18"/><path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

// ---------- show / hide ----------
for (const toggle of form.querySelectorAll('.input-toggle')) {
  toggle.innerHTML = EYE_ON + EYE_OFF;
  toggle.addEventListener('click', () => {
    const input = document.getElementById(toggle.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', toggle.getAttribute('aria-label').replace(show ? 'Show' : 'Hide', show ? 'Hide' : 'Show'));
    toggle.querySelector('.eye-on').hidden = show;
    toggle.querySelector('.eye-off').hidden = !show;
  });
}

// ---------- the rules, checked as the student types ----------
// Each rule is met or not met; the text stays the same, the icon and the colour change, and the rule list
// is tied to both new-password fields with aria-describedby so a screen reader can read it on demand.
function rules() {
  const me = session.me || {};
  const value = next.value;
  const lower = value.toLowerCase();
  const personal = [me.username, me.rollNumber].filter(Boolean).map(s => String(s).toLowerCase());
  return {
    length: value.length >= 8,
    plain: value !== '' && lower !== DEFAULT_PASSWORD && !personal.includes(lower),
    different: value !== '' && value !== current.value,
    match: value !== '' && value === confirm.value,
  };
}

function updateRules() {
  const state = rules();
  for (const li of document.querySelectorAll('#pwRules li'))
    li.dataset.met = state[li.dataset.rule] ? 'true' : 'false';
  saveBtn.disabled = !(current.value && Object.values(state).every(Boolean));
}
form.addEventListener('input', () => {
  currentMsg.hidden = true;
  errorEl.hidden = true;
  current.removeAttribute('aria-invalid');
  updateRules();
});

// ---------- open / close ----------
function open({ first = false } = {}) {
  if (dialog.open) return;
  form.reset();
  for (const toggle of form.querySelectorAll('.input-toggle[aria-pressed="true"]')) toggle.click(); // back to hidden
  currentMsg.hidden = true;
  errorEl.hidden = true;
  document.querySelector('#pwIntro').hidden = !first;
  laterBtn.textContent = first ? 'Later' : 'Cancel';
  updateRules();
  dialog.showModal();
  current.focus();
}
window.addEventListener('student:change-password', ev => open(ev.detail || {}));
laterBtn.addEventListener('click', () => dialog.close());

// ---------- save ----------
form.addEventListener('submit', async ev => {
  ev.preventDefault();
  if (saveBtn.disabled) return;
  errorEl.hidden = true;
  saveBtn.setAttribute('aria-busy', 'true');
  saveBtn.disabled = true;
  const res = await apiPost('/api/student/password', { currentPassword: current.value, newPassword: next.value }, { timeoutMs: 15000 });
  saveBtn.removeAttribute('aria-busy');
  if (!res.ok) {
    updateRules();
    const text = SERVER_ERRORS[res.error] || 'Could not change the password. Try again.';
    if (res.error === 'wrong_password') {
      currentMsg.textContent = text;
      currentMsg.hidden = false;
      current.setAttribute('aria-invalid', 'true');
      current.focus();
    } else {
      errorEl.textContent = text;
      errorEl.hidden = false;
    }
    return;
  }
  // Keep the saved sign-in in step, so the "Finish setting up" card clears
  try {
    const user = getCurrentUser();
    if (user) localStorage.setItem('user', JSON.stringify({ ...user, mustChangePassword: false }));
  } catch {
    // storage blocked: the server value still wins on the next load
  }
  dialog.close();
  form.reset();
  showToast('Password changed.', 'success');
  window.dispatchEvent(new CustomEvent('student:changed'));
});
