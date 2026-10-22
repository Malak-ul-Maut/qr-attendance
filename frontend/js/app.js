// Entry point of the student page: header, tabs, then the tab modules.
import { getCurrentUser } from '../utils/storage.js';
import { session } from './state.js';
import { showToast } from './ui.js';
import { mountAccountMenu } from './account-menu.js';
import './today.js';
import './attendance.js';
import './profile.js';
// scan-flow.js and enroll.js (QR scanner, face engine, pose coaching: about 100 KB) are not needed to show the
// Today tab. They load the first time they are asked for, or in the background once the page has settled.

const user = getCurrentUser() ?? {}; // auth-guard.js redirects when nobody is signed in
mountAccountMenu(document.querySelector('#accountMenu'), {
  user,
  role: 'student',
  // Until the password form becomes a dialog (Stage 5), this opens it on the Profile tab
  onChangePassword: () => {
    window.dispatchEvent(new Event('student:change-password'));
    window.dispatchEvent(new CustomEvent('student:goto', { detail: 'profile' }));
  },
});

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

// ---------- lazy modules ----------
// event the other tabs send -> the module that answers it (the module adds its own listener when it loads)
const LAZY_EVENTS = {
  'student:scan': './scan-flow.js',
  'student:enrol': './enroll.js',
  'student:selftest': './enroll.js',
};
// Written out one by one (not import(variable)) so the build can find each module and split it into its own file.
const LOADERS = {
  './scan-flow.js': () => import('./scan-flow.js'),
  './enroll.js': () => import('./enroll.js'),
};
const loading = new Map(); // module path -> promise

function ensureModule(path) {
  if (!loading.has(path)) {
    const promise = LOADERS[path]().then(
      () => {
        // The real listeners exist now. Remove ours so an event is never handled twice.
        for (const [name, target] of Object.entries(LAZY_EVENTS)) if (target === path) window.removeEventListener(name, onLazyEvent);
      },
      error => {
        loading.delete(path); // allow another try
        throw error;
      },
    );
    loading.set(path, promise);
  }
  return loading.get(path);
}

async function onLazyEvent(ev) {
  const path = LAZY_EVENTS[ev.type];
  const button = ev.detail?.button;
  button?.setAttribute('aria-busy', 'true');
  try {
    await ensureModule(path);
  } catch (error) {
    console.error('Could not load', path, error);
    return showToast('Could not load this part of the page. Check your connection and try again.', 'error');
  } finally {
    button?.removeAttribute('aria-busy');
  }
  // The event has already passed; send it again to the module that has just started listening.
  window.dispatchEvent(new CustomEvent(ev.type, { detail: ev.detail }));
}
for (const name of Object.keys(LAZY_EVENTS)) window.addEventListener(name, onLazyEvent);

// Once Today has drawn, use the idle time to fetch what this student will need next, so the tap feels instant.
window.addEventListener('student:ready', () => {
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1));
  setTimeout(() => idle(async () => {
    const me = session.me;
    if (!me) return;
    try {
      if (me.faceEnrolled || me.galleryEnrolled) {
        await ensureModule('./scan-flow.js');
      } else {
        await ensureModule('./enroll.js');
        // Not enrolled yet: download the 27 MB of face files in the background while they read their page,
        // so the enrolment dialog opens ready. Skipped on Data Saver and while their photos are being checked.
        const saveData = navigator.connection?.saveData;
        if (!saveData && me.faceStatus !== 'pending') {
          const { engine } = await import('./face/engine.js');
          engine.prefetch();
        }
      }
    } catch (error) {
      console.warn('Background loading did not finish', error);
    }
  }), 1500);
}, { once: true });
