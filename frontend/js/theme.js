// theme.js - light/dark theme choice. Loaded as a plain (non-module) script in <head>
// so the saved choice is applied before the page paints (no white flash).
//
// How it works:
//  - Nothing saved: the page follows the device setting (tokens.css handles this).
//  - Person flips a theme control: we save "light" or "dark" and set data-theme on <html>.
//  - Two kinds of control work: .theme-switch (role="switch", aria-checked; used on the public pages and inside the
//    account menu) and the older icon button .theme-toggle (aria-pressed).
//  - Clicks are handled on the document, so controls that are added later (the account menu is built by script)
//    work without any wiring. After adding one, call window.syncThemeControls() to set its state.
//  - If the page has <meta name="theme-color">, it follows the theme so the phone's address bar matches.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;
  var SELECTOR = '.theme-switch, .theme-toggle';

  // Read the saved choice (storage can be blocked in private mode, so guard it)
  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  // What the person is looking at right now: their choice, else the device setting
  function current() {
    var s = saved();
    if (s === 'light' || s === 'dark') return s;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var initial = saved();
  if (initial === 'light' || initial === 'dark') root.setAttribute('data-theme', initial);

  function refresh() {
    var dark = current() === 'dark';
    document.querySelectorAll(SELECTOR).forEach(function (c) {
      if (c.classList.contains('theme-switch')) {
        c.setAttribute('aria-checked', String(dark)); // the label stays "Dark mode"; the state is aria-checked
      } else {
        c.setAttribute('aria-pressed', String(dark));
        c.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
        c.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
      }
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var canvas = getComputedStyle(root).getPropertyValue('--canvas').trim();
      meta.setAttribute('content', canvas || (dark ? '#15171a' : '#f4f5f7'));
    }
  }
  window.syncThemeControls = refresh;

  document.addEventListener('click', function (e) {
    var control = e.target.closest && e.target.closest(SELECTOR);
    if (!control) return;
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(KEY, next); } catch (err) { /* choice just won't persist */ }
    refresh();
  });

  document.addEventListener('DOMContentLoaded', refresh);
})();
