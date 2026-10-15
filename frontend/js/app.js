// Entry point of the student page: header, tabs, then the tab modules.
import { getCurrentUser } from '../utils/storage.js';
import './today.js';
import './attendance.js';
import './profile.js';
import './scan-flow.js';
import './enroll.js';

const user = getCurrentUser() ?? {}; // auth-guard.js redirects when nobody is signed in
document.querySelector('.user-name b').textContent = user.name || '';

const tabs = [...document.querySelectorAll('.nav-item')];

function showTab(name, { focus = true } = {}) {
  tabs.forEach(t => (t.dataset.view === name ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== `view-${name}`));
  // Land on the new heading so screen-reader users hear where they are
  if (focus) document.querySelector(`#view-${name} h1`)?.focus({ preventScroll: true });
  window.dispatchEvent(new CustomEvent('student:tab', { detail: name }));
}

tabs.forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.view)));
// Other tabs can send the student somewhere (the "Finish setting up" card opens Profile)
window.addEventListener('student:goto', ev => showTab(ev.detail));
