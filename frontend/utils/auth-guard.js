import { adminTokenExpiry, endSession } from './storage.js';

checkAuthAndRedirect();

function checkAuthAndRedirect() {
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    // damaged value: treated as signed out
  }
  if (!user) return (window.location.href = '/homepage.html');

  // The admin page also needs an admin token that has not expired yet
  if (window.location.pathname.endsWith('/admin.html')) {
    const expiresAt = user.adminToken ? adminTokenExpiry(user.adminToken) : null;
    if (!expiresAt) return endSession('Please sign in as admin to open this page.');
    if (expiresAt <= Date.now()) return endSession('Your admin session expired. Please sign in again.');
  }
}
