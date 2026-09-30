// ==========================================================================
// Homepage interactions — GSAP entrance sequence + QR scan animation
// ==========================================================================

(function buildQrGrid() {
  const grid = document.getElementById('qrGrid');
  if (!grid) return;

  // Fixed pseudo-random pattern so the "QR code" looks real but is stable
  // across reloads (deterministic seed, not Math.random()).
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const cell = 10;
  const cols = 18;
  const rows = 18;
  const skipZones = [
    [0, 0, 5, 5], // top-left finder
    [12, 0, 17, 5], // top-right finder
    [0, 12, 5, 17], // bottom-left finder
  ];

  const inSkipZone = (c, r) =>
    skipZones.some(
      ([x1, y1, x2, y2]) => c >= x1 && c <= x2 && r >= y1 && r <= y2,
    );

  let markup = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (inSkipZone(c, r)) continue;
      if (rand() > 0.56) {
        const dim = rand() > 0.75;
        markup += `<rect class="qr-cell${dim ? ' dim' : ''}" x="${8 + c * cell}" y="${8 + r * cell}" width="${cell - 2}" height="${cell - 2}" rx="1.5" />`;
      }
    }
  }
  grid.innerHTML = markup;
})(); //IIFE to build the QR grid on page load

// ---- Theme toggle: light / dark / system --------------------------------
(function themeToggle() {
  const buttons = document.querySelectorAll('[data-theme-choice]');
  if (!buttons.length) return;

  const root = document.documentElement;

  const getChoice = () => localStorage.getItem('theme') || 'system'; // 'light' | 'dark' | 'system'

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
})();

document.addEventListener('DOMContentLoaded', () => {
  const prefersReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  if (typeof gsap === 'undefined') return;

  if (prefersReducedMotion) {
    gsap.set('.hero-copy > *, .hero-graphic, .link-card', {
      opacity: 1,
      y: 0,
      scale: 1,
    });
    return;
  }

  // One orchestrated page-load sequence: header, hero copy, then the scan graphic.
  const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });

  tl.from('.site-header', { y: -16, opacity: 0, duration: 0.5 })
    .from(
      '.hero-copy > *',
      { y: 22, opacity: 0, duration: 0.6, stagger: 0.12 },
      '-=0.2',
    )
    .from('.hero-graphic', { scale: 0.94, opacity: 0, duration: 0.6 }, '-=0.5')
    .from(
      '.link-card',
      { y: 18, opacity: 0, duration: 0.5, stagger: 0.1 },
      '-=0.3',
    );

  // The single looping accent: a scan line sweeping the QR graphic,
  // echoing the literal act the product performs.
  gsap.to(['#scanLine', '#scanGlow'], {
    y: 176,
    duration: 2.2,
    ease: 'sine.inOut',
    repeat: -1,
    yoyo: true,
  });

  // Card hover — driven by GSAP rather than CSS transitions, per spec.
  document.querySelectorAll('.link-card').forEach(card => {
    const play = () =>
      gsap.to(card, {
        y: -6,
        scale: 1.015,
        boxShadow: '0 20px 40px -16px rgba(18,23,43,0.22)',
        duration: 0.3,
        ease: 'power2.out',
      });
    const reset = () =>
      gsap.to(card, {
        y: 0,
        scale: 1,
        boxShadow:
          '0 1px 2px rgba(18,23,43,0.04), 0 8px 24px -12px rgba(18,23,43,0.12)',
        duration: 0.3,
        ease: 'power2.out',
      });

    card.addEventListener('mouseenter', play);
    card.addEventListener('mouseleave', reset);
    card.addEventListener('focus', play);
    card.addEventListener('blur', reset);
  });
});
