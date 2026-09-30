// ==========================================================================
// Theme toggle: light / dark / system (used by login-page.html)
// Split out of the old login-page.js so that file can stay exactly as your
// own login code. Same logic as the toggle in js/homepage.js.
// ==========================================================================
const buttons = document.querySelectorAll('[data-theme-choice]');

if (buttons.length) {
  const root = document.documentElement;
  const getChoice = () => localStorage.getItem('theme') || 'system';

  const applyChoice = choice => {
    if (choice === 'light' || choice === 'dark') {
      root.setAttribute('data-theme', choice);
      localStorage.setItem('theme', choice);
    } else {
      root.removeAttribute('data-theme'); // let prefers-color-scheme decide
      localStorage.removeItem('theme');
    }
    buttons.forEach(btn => {
      btn.setAttribute(
        'aria-pressed',
        String(btn.dataset.themeChoice === choice),
      );
    });
  };

  buttons.forEach(btn => {
    btn.addEventListener('click', () => applyChoice(btn.dataset.themeChoice));
  });

  applyChoice(getChoice());
}
