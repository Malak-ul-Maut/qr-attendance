// admin.js - the admin portal shell: four tabs (Home, Setup, Timetable, Face photos).
import { $, $$, currentUser, showToast } from './admin/core.js';
import { logout, adminTokenExpiry } from '/utils/storage.js';
import { loadHome } from './admin/home.js';
import { loadMaster } from './admin/master.js';
import { loadTimetable } from './admin/timetable.js';
import { loadEnrollment } from './admin/enrollment.js';

$('.user-name b').textContent = currentUser.name || 'Admin';
$('.logout-btn').addEventListener('click', () => logout());

const VIEWS = {
  home: { title: 'Home', load: loadHome },
  master: { title: 'Setup', load: loadMaster },
  timetable: { title: 'Timetable', load: loadTimetable },
  enrollment: { title: 'Face photos', load: loadEnrollment },
};

function showView(name, { moveFocus = false } = {}) {
  if (!VIEWS[name]) name = 'home';
  $$('.nav-item').forEach(item => (item.dataset.view === name ? item.setAttribute('aria-current', 'page') : item.removeAttribute('aria-current')));
  Object.keys(VIEWS).forEach(view => (document.getElementById(`view-${view}`).hidden = view !== name));
  document.title = `${VIEWS[name].title} | Admin`;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (moveFocus) document.getElementById(`${name}Title`)?.focus();
  VIEWS[name].load();
}

$$('.nav-item').forEach(item => item.addEventListener('click', () => showView(item.dataset.view, { moveFocus: true })));
// Other tabs ask to jump somewhere (e.g. "See who is pending")
document.addEventListener('admin:goto', e => showView(e.detail, { moveFocus: true }));
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

if (!currentUser.adminToken) {
  document.querySelector('main').prepend(Object.assign(document.createElement('p'), {
    className: 'alert alert-danger', role: 'alert', textContent: 'Sign out and sign in again as admin to load data.',
  }));
}
showView(location.hash.slice(1));

// Warn five minutes before the admin session ends so unsaved work is not a surprise.
// (After it ends, the next request sends the person to the login page with an explanation.)
const sessionEnds = currentUser.adminToken ? adminTokenExpiry(currentUser.adminToken) : null;
if (sessionEnds) {
  const warnIn = sessionEnds - 5 * 60 * 1000 - Date.now();
  if (warnIn > 0 && warnIn < 2 ** 31)
    setTimeout(() => showToast('Your admin session ends in about 5 minutes. Finish what you are doing, then sign in again.', 'info', 30000), warnIn);
}
