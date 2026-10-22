// account-menu.js - the avatar button in the app header and the panel it opens (student, faculty and admin pages).
//
//   import { mountAccountMenu } from './account-menu.js';
//   mountAccountMenu(document.querySelector('#accountMenu'), { user, role: 'student', onChangePassword });
//
// The panel holds who is signed in, the dark-mode switch, "Change password" (only where the page can do it: pass
// onChangePassword) and Log out. It is a plain show/hide panel, not an ARIA menu: every control is a normal
// button reached with Tab, so no arrow-key handling is needed.
//   Escape or a click or Tab outside closes it; Escape returns focus to the avatar button.
import { logout } from '../utils/storage.js';

const TITLES = /^(dr|prof|mr|mrs|ms|mx|er|shri|smt)\.?$/i;
const ROLE_LABEL = { student: 'Student', faculty: 'Faculty', admin: 'Admin' };

/** "Dr. A. K. Sharma" -> "AS", "Admin" -> "A", "" -> fallback. Titles are skipped. */
export function initialsOf(name, fallback = '?') {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(word => word && !TITLES.test(word));
  if (!words.length) return fallback;
  const letter = word => Array.from(word)[0];
  const first = letter(words[0]);
  const last = words.length > 1 ? letter(words[words.length - 1]) : '';
  return (first + last).toUpperCase();
}

export const roleLabel = role => ROLE_LABEL[role] ?? '';

const SVG = {
  sun: '<svg class="ts-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="ts-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/></svg>',
  out: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 8l4 4-4 4M20 12H9"/></svg>',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only ever the constant SVG strings above
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(Boolean)); // a skipped row is null, and append() would print it as the text "null"
  return node;
}

export function mountAccountMenu(slot, { user = {}, role, onChangePassword } = {}) {
  if (!slot) return null;
  const name = user.name || (role === 'admin' ? 'Admin' : '');
  const initials = initialsOf(name, roleLabel(role)[0] || '?');
  const detail = [roleLabel(role), user.username].filter(Boolean).join(' · ');

  const button = el('button', {
    class: 'account-btn',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'accountPanel',
    'aria-label': name ? `Account menu for ${name}` : 'Account menu',
  }, el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials }));

  const themeRow = el('button', { class: 'account-item theme-switch', type: 'button', role: 'switch', 'aria-checked': 'false' },
    el('span', { text: 'Dark mode' }),
    el('span', { class: 'theme-switch-track', 'aria-hidden': 'true', html: `${SVG.sun}${SVG.moon}<span class="theme-switch-thumb"></span>` }));

  const passwordRow = onChangePassword
    ? el('button', { class: 'account-item', type: 'button', 'data-act': 'password' }, el('span', { text: 'Change password' }), el('span', { 'aria-hidden': 'true', html: SVG.key }))
    : null;
  const logoutRow = el('button', { class: 'account-item account-logout', type: 'button', 'data-act': 'logout' }, el('span', { text: 'Log out' }), el('span', { 'aria-hidden': 'true', html: SVG.out }));

  const panel = el('div', { class: 'account-panel', id: 'accountPanel', hidden: true },
    el('div', { class: 'account-who' },
      el('span', { class: 'avatar avatar-lg', 'aria-hidden': 'true', text: initials }),
      el('span', { class: 'account-id' }, el('strong', { text: name || roleLabel(role) }), el('span', { text: detail }))),
    themeRow, passwordRow, logoutRow);

  const root = el('div', { class: 'account' }, button, panel);
  slot.replaceChildren(root);
  window.syncThemeControls?.(); // theme.js: set the new switch to the current theme

  const isOpen = () => !panel.hidden;
  function setOpen(open, { returnFocus = false } = {}) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open && returnFocus) button.focus();
  }

  button.addEventListener('click', () => setOpen(!isOpen()));
  root.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && isOpen()) {
      ev.stopPropagation();
      setOpen(false, { returnFocus: true });
    }
  });
  document.addEventListener('pointerdown', ev => { if (isOpen() && !root.contains(ev.target)) setOpen(false); });
  document.addEventListener('focusin', ev => { if (isOpen() && !root.contains(ev.target)) setOpen(false); });

  panel.addEventListener('click', ev => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'password') { setOpen(false); onChangePassword(); }
    if (act === 'logout') logout();
  });
  return { open: () => setOpen(true), close: () => setOpen(false), button, panel };
}
