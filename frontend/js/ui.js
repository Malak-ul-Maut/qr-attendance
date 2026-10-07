// ui.js - small helpers shared by every page.

// One fixed stack with two live lanes: polite for normal messages, assertive (role="alert") for
// errors, so screen readers announce a failure straight away instead of waiting for a pause.
function toastLane(kind) {
  let stack = document.querySelector('.toast-region');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-region';
    document.body.appendChild(stack);
  }
  let lane = stack.querySelector(`.toast-lane[data-kind="${kind}"]`);
  if (!lane) {
    lane = document.createElement('div');
    lane.className = 'toast-lane';
    lane.dataset.kind = kind;
    lane.setAttribute('role', kind === 'alert' ? 'alert' : 'status');
    stack.appendChild(lane);
  }
  return lane;
}

// Shows a short message at the bottom of the screen with a close button.
// type: 'info' (default), 'success' or 'error'. Errors stay longer (they often say what to fix)
// and every toast stays while the pointer is over it or keyboard focus is inside it.
export function showToast(message, type = 'info', durationMs) {
  const isError = type === 'error';
  const lifetime = durationMs ?? (isError ? 10000 : type === 'success' ? 5000 : 6000);
  const region = toastLane(isError ? 'alert' : 'status');

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  toast.append(text, close);
  region.appendChild(toast);

  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    toast.remove();
  };
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(remove, lifetime);
  };
  const pause = () => clearTimeout(timer);
  close.addEventListener('click', remove);
  toast.addEventListener('mouseenter', pause);
  toast.addEventListener('mouseleave', start);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', start);
  toast.addEventListener('keydown', event => {
    if (event.key === 'Escape') remove();
  });
  start();
}
