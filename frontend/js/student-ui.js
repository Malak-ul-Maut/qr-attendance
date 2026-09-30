// ==========================================================================
// Student dashboard — presentation layer only.
//
// Kept entirely separate from js/student.js (the user's own file): this
// script never reassigns anything student.js owns, and where it needs to
// react to what student.js does (opening the scanner, updating the result
// text) it observes the DOM from the outside with MutationObserver rather
// than importing or calling into student.js.
//
// The one exception is getCurrentUser() below — that's read from
// utils/storage.js, the same read-only helper js/student.js itself imports,
// just to render the avatar. Nothing here writes back to storage.
// ==========================================================================

import { getCurrentUser } from '../utils/storage.js';

const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;
const hasGsap = typeof gsap !== 'undefined';

// ---- Entrance animation ---------------------------------------------------
function playEntrance() {
  const tiles = document.querySelectorAll('.roles .link-card');

  if (!hasGsap || prefersReducedMotion) {
    return; // elements are visible by default — nothing to reveal
  }

  gsap
    .timeline({ defaults: { ease: 'power2.out' } })
    .from('header', { y: -16, opacity: 0, duration: 0.45 })
    .from(tiles, { y: 20, opacity: 0, duration: 0.5, stagger: 0.1 }, '-=0.15');
}

// ---- Tile hover -----------------------------------------------------------
function wireTileHover() {
  if (!hasGsap || prefersReducedMotion) return;

  document.querySelectorAll('.roles .link-card').forEach(card => {
    const icon = card.querySelector('img');

    const enter = () => {
      gsap.to(card, {
        y: -5,
        scale: 1.015,
        duration: 0.25,
        ease: 'power2.out',
      });
      if (icon)
        gsap.to(icon, { scale: 1.12, duration: 0.25, ease: 'back.out(2)' });
    };
    const leave = () => {
      gsap.to(card, { y: 0, scale: 1, duration: 0.25, ease: 'power2.out' });
      if (icon) gsap.to(icon, { scale: 1, duration: 0.25, ease: 'power2.out' });
    };

    card.addEventListener('mouseenter', enter);
    card.addEventListener('mouseleave', leave);
    card.addEventListener('focus', enter);
    card.addEventListener('blur', leave);
  });
}

// ---- Toast ---------------------------------------------------
const toastEl = document.getElementById('toast');
let toastTimer = null;

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// "Subjects" and "History" tiles have no page to go to yet — better an
// honest toast than a click that silently does nothing.
document
  .querySelectorAll('.roles .link-card:not(#markAttendanceCard)')
  .forEach(card => {
    const label = card.querySelector('p');
    card.addEventListener('click', () => {
      showToast(
        `${label ? label.textContent : 'This section'} is coming soon.`,
      );
    });
  });

// ---- Profile menu: avatar + dropdown (Home / Theme / Log out) ------------
// The dropdown contains the *actual* .logout-btn element (moved here from
// the old header layout, not a copy) — js/student.js does
// document.querySelector('.logout-btn'), so there must be exactly one.
renderAvatar();
wireProfileMenu();

function initials(name) {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase();
}

function renderAvatar() {
  const avatarImg = document.getElementById('avatarImg');
  const avatarInitials = document.getElementById('avatarInitials');
  if (!avatarImg || !avatarInitials) return;

  let user = null;
  try {
    user = getCurrentUser();
  } catch {
    // Not signed in yet, or utils/storage.js has a different shape —
    // fall back to the placeholder initials below.
  }

  const name = user && user.name;
  const photo =
    user &&
    (user.photoUrl ||
      user.photo ||
      user.avatarUrl ||
      user.avatar ||
      user.image);

  avatarInitials.textContent = initials(name);

  if (!photo) return;

  avatarImg.src = photo;
  avatarImg.alt = name ? `${name}'s photo` : 'Profile photo';
  avatarImg.hidden = false;
  avatarInitials.hidden = true;

  avatarImg.addEventListener('error', () => {
    // Broken/missing image — fall back to the initials instead of a
    // broken-image icon.
    avatarImg.hidden = true;
    avatarImg.removeAttribute('src');
    avatarInitials.hidden = false;
  });
}

function wireProfileMenu() {
  const profileBtn = document.getElementById('profileBtn');
  const profileMenu = document.querySelector('.profile-menu');
  const dropdown = document.getElementById('profileDropdown');
  if (!profileBtn || !profileMenu || !dropdown) return;

  const getItems = () =>
    Array.from(dropdown.querySelectorAll('a, button, [tabindex="0"]'));

  function onOutsideClick(e) {
    if (!profileMenu.contains(e.target)) closeMenu({ refocus: false });
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }

    // Simple focus trap: wrap Tab within the dropdown while it's open.
    if (e.key === 'Tab') {
      const items = getItems();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function openMenu() {
    dropdown.hidden = false;
    // Flip to the "open" state on the next frame so the opacity/transform
    // transition in header.css actually has something to animate from.
    requestAnimationFrame(() => profileMenu.classList.add('open'));
    profileBtn.setAttribute('aria-expanded', 'true');
    const items = getItems();
    if (items[0]) items[0].focus();
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onKeydown);
  }

  function closeMenu({ refocus = true } = {}) {
    profileMenu.classList.remove('open');
    profileBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onKeydown);
    setTimeout(() => {
      if (!profileMenu.classList.contains('open')) dropdown.hidden = true;
    }, 200);
    if (refocus) profileBtn.focus();
  }

  profileBtn.addEventListener('click', () => {
    if (profileMenu.classList.contains('open')) closeMenu();
    else openMenu();
  });

  // Home navigates away and Log out triggers js/student.js's own handler —
  // either way, close the panel behind them rather than leaving it open.
  dropdown.querySelectorAll('a, .logout-btn').forEach(item => {
    item.addEventListener('click', () => closeMenu({ refocus: false }));
  });

  if (hasGsap && !prefersReducedMotion) {
    profileBtn.addEventListener('mouseenter', () =>
      gsap.to(profileBtn, { scale: 1.08, duration: 0.2, ease: 'back.out(2)' }),
    );
    profileBtn.addEventListener('mouseleave', () =>
      gsap.to(profileBtn, { scale: 1, duration: 0.2 }),
    );
  }
}

// ---- Scanner entrance + step readout ---------------------------------------------------
const scannerSection = document.getElementById('scanner-section');
const cameraWrapper = document.querySelector('.camera-wrapper');
const scanResult = document.getElementById('scan-result');
const steps = document.querySelectorAll('#scanSteps li');

function resetSteps() {
  steps.forEach(li => li.classList.remove('active', 'done', 'error'));
  if (steps[0]) steps[0].classList.add('active');
}

function updateSteps(text) {
  const t = (text || '').toLowerCase();
  const [qrStep, faceStep] = steps;
  if (!qrStep || !faceStep) return;

  if (t.includes('verification failed')) {
    // Whichever step was in progress gets marked as the failure point.
    const failing =
      faceStep.classList.contains('active') ||
      faceStep.classList.contains('done')
        ? faceStep
        : qrStep;
    failing.classList.add('error');
    failing.classList.remove('active');
    return;
  }

  if (t.includes('attendance marked successfully')) {
    qrStep.classList.add('done');
    qrStep.classList.remove('active', 'error');
    faceStep.classList.add('done');
    faceStep.classList.remove('active', 'error');
    return;
  }

  if (
    t.includes('scanning face') ||
    t.includes('smile') ||
    t.includes('submitting')
  ) {
    qrStep.classList.add('done');
    qrStep.classList.remove('active', 'error');
    faceStep.classList.add('active');
    faceStep.classList.remove('error');
    return;
  }

  if (t.includes('verifying qr')) {
    qrStep.classList.add('active');
    qrStep.classList.remove('error');
  }
}

if (scannerSection) {
  const styleObserver = new MutationObserver(() => {
    const isOpen =
      scannerSection.style.display !== 'none' &&
      scannerSection.style.display !== '';

    if (isOpen) {
      resetSteps();
      if (hasGsap && !prefersReducedMotion && cameraWrapper) {
        gsap.fromTo(
          cameraWrapper,
          { opacity: 0, scale: 0.92 },
          { opacity: 1, scale: 1, duration: 0.35, ease: 'power2.out' },
        );
      }
    }
  });
  styleObserver.observe(scannerSection, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

if (scanResult) {
  const textObserver = new MutationObserver(() =>
    updateSteps(scanResult.textContent),
  );
  textObserver.observe(scanResult, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// ---- Go ---------------------------------------------------
playEntrance();
wireTileHover();
