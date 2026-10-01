// theme.js - light/dark theme choice. Loaded as a plain (non-module) script in <head>
// so the saved choice is applied before the page paints (no white flash).
//
// How it works:
//  - Nothing saved: the page follows the device setting (tokens.css handles this).
//  - Person taps the theme button: we save "light" or "dark" and set data-theme on <html>.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;

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

  // Wire up any .theme-toggle buttons once the page has loaded
  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('.theme-toggle');
    function refresh() {
      var dark = current() === 'dark';
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(dark));
        b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
        b.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
      });
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) { /* choice just won't persist */ }
        refresh();
      });
    });
    refresh();
  });
})();
