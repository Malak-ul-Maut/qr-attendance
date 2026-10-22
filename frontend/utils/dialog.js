// dialog.js - close a <dialog> when the dark area around it is clicked.
//
//   import { enableLightDismissAll } from '../utils/dialog.js';
//   enableLightDismissAll();                       // every <dialog class="dialog"> on the page
//
// What each dialog does is set in its HTML with data-modal:
//   (nothing)            click outside closes it. For viewers, confirmations and pickers.
//   data-modal="guard"   click outside closes it only while nothing has been typed or changed. For forms: once the
//                        person edits a field, an outside click only nudges the dialog instead of losing their work.
//   data-modal="strict"  click outside never closes it. For the term wizard and the one-time password dialog.
// A dialog can also pass { canDismiss: () => ... } to veto the close at run time.
//
// Two details that make this feel right:
//  - A drag that starts inside the dialog (selecting text) and ends outside it must not close it, so the press
//    has to START on the backdrop too.
//  - It closes the same way Escape does, so any existing 'cancel' / 'close' handlers still run.

/** True when the point (x, y) is outside the rectangle. The click target of a <dialog> is the dialog itself for
 *  both its own padding and the backdrop, so the position is what tells them apart. */
export const isOutside = (rect, x, y) => x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;

function closeLikeEscape(dialog) {
  if (typeof dialog.requestClose === 'function') return dialog.requestClose();
  // Older browsers: fire the cancel event first and honour preventDefault(), as Escape would.
  const proceed = dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  if (proceed) dialog.close();
}

// A short shake (see .dialog[data-nudge] in components.css) that says "not closing, you have unsaved edits".
function nudge(dialog) {
  dialog.setAttribute('data-nudge', '');
  setTimeout(() => dialog.removeAttribute('data-nudge'), 320);
}

// Remember that the person has typed or changed something. Cleared whenever the dialog closes.
function trackDirty(dialog) {
  const mark = () => (dialog.dataset.dirty = '1');
  dialog.addEventListener('input', mark);
  dialog.addEventListener('change', mark);
  dialog.addEventListener('close', () => delete dialog.dataset.dirty);
}

export function enableLightDismiss(dialog, { canDismiss } = {}) {
  if (!dialog || dialog.dataset.lightDismiss === 'on') return;
  dialog.dataset.lightDismiss = 'on';
  if (dialog.dataset.modal === 'guard') trackDirty(dialog);
  let pressedOutside = false;

  dialog.addEventListener('pointerdown', e => {
    pressedOutside = e.target === dialog && isOutside(dialog.getBoundingClientRect(), e.clientX, e.clientY);
  });
  dialog.addEventListener('click', e => {
    const startedOutside = pressedOutside;
    pressedOutside = false;
    if (!startedOutside || e.target !== dialog) return;
    if (!isOutside(dialog.getBoundingClientRect(), e.clientX, e.clientY)) return;
    if (dialog.dataset.modal === 'strict') return;
    const unsaved = dialog.dataset.modal === 'guard' && dialog.dataset.dirty === '1';
    if (unsaved || (canDismiss && !canDismiss())) return nudge(dialog);
    closeLikeEscape(dialog);
  });
}

export function enableLightDismissAll(root = document) {
  for (const dialog of root.querySelectorAll('dialog.dialog')) {
    if (dialog.dataset.modal !== 'strict') enableLightDismiss(dialog);
  }
}
