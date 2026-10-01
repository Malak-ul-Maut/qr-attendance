// ui.js - small helpers shared by every page.

// Shows a short message at the bottom of the screen, then removes it.
// type can be 'info' (default), 'success' or 'error'.
export function showToast(message, type = 'info', durationMs = 4000) {
  // Create the container that holds all toasts the first time we need it
  let toastRegion = document.querySelector('.toast-region');
  if (!toastRegion) {
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.setAttribute('role', 'status'); // screen readers read new toasts aloud
    document.body.appendChild(toastRegion);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);

  // Remove this toast after a few seconds
  setTimeout(() => toast.remove(), durationMs);
}
