// ==========================================================================
// Faculty dashboard — presentation layer only.
//
// Kept entirely separate from js/faculty.js (the user's own file): this
// script never reassigns anything faculty.js owns, and where it needs to
// react to what faculty.js does (starting a session, updating the student
// list) it observes the DOM from the outside with MutationObserver rather
// than importing or calling into faculty.js.
//
// The one exception is getCurrentUser() below — that's read from
// utils/storage.js, the same read-only helper js/faculty.js itself imports
// (as /utils/storage.js there), just to render the avatar. Nothing here
// writes back to storage.
// ==========================================================================

import { getCurrentUser } from '/utils/storage.js';

const prefersReducedMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
).matches;
const hasGsap = typeof gsap !== 'undefined';
const animate = hasGsap && !prefersReducedMotion;

// ---- Entrance animation ---------------------------------------------------
if (animate) {
  gsap
    .timeline({ defaults: { ease: 'power2.out' } })
    .from('header', { y: -16, opacity: 0, duration: 0.45 })
    .from(
      '.sidebar-content',
      { x: -14, opacity: 0, duration: 0.4, stagger: 0.06 },
      '-=0.2',
    )
    .from('#beforeStart', { y: 16, opacity: 0, duration: 0.45 }, '-=0.25');
}

// ---- Sidebar item hover ---------------------------------------------------
if (animate) {
  document.querySelectorAll('.sidebar-content').forEach(item => {
    const icon = item.querySelector('img');
    if (!icon) return;

    item.addEventListener('mouseenter', () =>
      gsap.to(icon, { scale: 1.15, duration: 0.2, ease: 'back.out(2)' }),
    );
    item.addEventListener('mouseleave', () =>
      gsap.to(icon, { scale: 1, duration: 0.2 }),
    );
    item.addEventListener('focus', () =>
      gsap.to(icon, { scale: 1.15, duration: 0.2, ease: 'back.out(2)' }),
    );
    item.addEventListener('blur', () =>
      gsap.to(icon, { scale: 1, duration: 0.2 }),
    );
  });
}

// ---- Profile menu: avatar + dropdown (Home / Theme / Log out) ------------
// The dropdown contains the *actual* .logout-btn element (moved here from
// the old sidebar, not a copy) — js/faculty.js does
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

  dropdown.querySelectorAll('a, .logout-btn').forEach(item => {
    item.addEventListener('click', () => closeMenu({ refocus: false }));
  });

  if (animate) {
    profileBtn.addEventListener('mouseenter', () =>
      gsap.to(profileBtn, { scale: 1.08, duration: 0.2, ease: 'back.out(2)' }),
    );
    profileBtn.addEventListener('mouseleave', () =>
      gsap.to(profileBtn, { scale: 1, duration: 0.2 }),
    );
  }
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

// Generate QR / History / Feedback have no page to go to yet — an honest
// toast beats a click that silently does nothing.
['generateQrNav', 'historyNav', 'feedbackNav'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const label = el.querySelector('div');
  el.addEventListener('click', () =>
    showToast(`${label ? label.textContent : 'This section'} is coming soon.`),
  );
});

// ---- Live session entrance ---------------------------------------------------
// js/faculty.js toggles #afterStart between display:none and display:flex
// when a session starts — this just animates that reveal.
const afterStart = document.getElementById('afterStart');
if (afterStart && animate) {
  const observer = new MutationObserver(() => {
    const isOpen =
      afterStart.style.display !== 'none' && afterStart.style.display !== '';
    if (isOpen) {
      gsap.fromTo(
        afterStart.children,
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: 'power2.out' },
      );
    }
  });
  observer.observe(afterStart, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

// ---- Live student list ---------------------------------------------------
// Animates each <li> js/faculty.js appends (from socket events or manual
// add) as it lands, instead of it just appearing.
const studentList = document.getElementById('studentList');
if (studentList && animate) {
  const listObserver = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1 && node.tagName === 'LI') {
          gsap.from(node, {
            opacity: 0,
            x: -12,
            duration: 0.35,
            ease: 'power2.out',
          });
        }
      });
    });
  });
  listObserver.observe(studentList, { childList: true });
}

// "Present: N" — counts up to the new number instead of just snapping to
// it, plus a small pulse, so a new check-in is felt even if the list itself
// is scrolled out of view. Falls back to leaving js/faculty.js's own text
// alone when GSAP/motion is off.
const studentCount = document.getElementById('studentCount');
if (studentCount && animate) {
  let lastText = studentCount.textContent;
  let lastValue = parseInt(lastText, 10) || 0;
  let countingUp = false;

  const countObserver = new MutationObserver(() => {
    if (countingUp || studentCount.textContent === lastText) return;

    const newText = studentCount.textContent;
    const newValue = parseInt(newText, 10);
    lastText = newText;
    if (Number.isNaN(newValue)) return; // e.g. "CCTV: processing..." — leave as-is

    const prefix = newText.replace(/\d+\s*$/, '');
    const from = { value: lastValue };
    lastValue = newValue;
    countingUp = true;

    gsap.to(from, {
      value: newValue,
      duration: 0.4,
      ease: 'power1.out',
      onUpdate: () => {
        countingUp = true;
        studentCount.textContent = `${prefix}${Math.round(from.value)}`;
      },
      onComplete: () => {
        studentCount.textContent = newText; // land on the exact real text
        countingUp = false;
      },
    });

    gsap.fromTo(
      studentCount,
      { scale: 1.18 },
      { scale: 1, duration: 0.3, ease: 'back.out(3)' },
    );
  });
  countObserver.observe(studentCount, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

// ---- "View CCTV Result" button: pulse the moment it becomes usable --------
const viewCctvResultBtn = document.getElementById('viewCctvResultBtn');
if (viewCctvResultBtn) {
  let wasDisabled = viewCctvResultBtn.disabled;
  const enabledObserver = new MutationObserver(() => {
    if (wasDisabled && !viewCctvResultBtn.disabled) {
      viewCctvResultBtn.classList.add('just-enabled');
      viewCctvResultBtn.addEventListener(
        'animationend',
        () => viewCctvResultBtn.classList.remove('just-enabled'),
        { once: true },
      );
    }
    wasDisabled = viewCctvResultBtn.disabled;
  });
  enabledObserver.observe(viewCctvResultBtn, {
    attributes: true,
    attributeFilter: ['disabled'],
  });
}

// ---- CCTV result modal ---------------------------------------------------
// js/faculty.js (presumably) just removes the "hidden" class to show this.
// The close button/backdrop here are new — they only ever re-add "hidden"
// client-side, never anything that assumes how js/faculty.js expects to
// be told the modal closed.
const cctvModal = document.getElementById('cctvResultModal');
if (cctvModal) {
  cctvModal.querySelectorAll('[data-modal-dismiss]').forEach(el => {
    el.addEventListener('click', () => {
      if (animate) {
        gsap.to(cctvModal.querySelector('.modal-panel'), {
          opacity: 0,
          scale: 0.94,
          duration: 0.15,
          ease: 'power1.in',
          onComplete: () => cctvModal.classList.add('hidden'),
        });
      } else {
        cctvModal.classList.add('hidden');
      }
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !cctvModal.classList.contains('hidden')) {
      cctvModal.querySelector('.modal-close')?.click();
    }
  });

  if (animate) {
    const modalObserver = new MutationObserver(() => {
      if (!cctvModal.classList.contains('hidden')) {
        gsap.fromTo(
          cctvModal.querySelector('.modal-panel'),
          { opacity: 0, scale: 0.92 },
          { opacity: 1, scale: 1, duration: 0.25, ease: 'power2.out' },
        );
      }
    });
    modalObserver.observe(cctvModal, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}

// ---- Fullscreen icon ---------------------------------------------------
// js/faculty.js's toggleFullScreen() only runs on its own button click, so
// it never fires again if the user leaves fullscreen with Esc. Listening to
// the browser's real fullscreenchange event instead keeps the icon correct
// either way.
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle(
    'is-fullscreen',
    Boolean(document.fullscreenElement),
  );
});

// ---- Manual-attendance dialog ---------------------------------------------------
// <dialog> gets an `open` attribute the instant showModal() runs, so this
// fires right as js/faculty.js opens it.
const manualDialog = document.getElementById('manual-attendance-dialog');
const manualList = document.getElementById('manual-attendance-list');
if (manualDialog && animate) {
  const dialogObserver = new MutationObserver(() => {
    if (manualDialog.hasAttribute('open')) {
      gsap.fromTo(
        manualDialog,
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.25, ease: 'power2.out' },
      );

      // js/faculty.js populates #manual-attendance-list before calling
      // showModal(), so the rows already exist by the time this fires.
      if (manualList && manualList.children.length) {
        gsap.from(manualList.children, {
          opacity: 0,
          y: 8,
          duration: 0.25,
          stagger: 0.04,
          ease: 'power2.out',
          delay: 0.1,
        });
      }
    }
  });
  dialogObserver.observe(manualDialog, {
    attributes: true,
    attributeFilter: ['open'],
  });
}
