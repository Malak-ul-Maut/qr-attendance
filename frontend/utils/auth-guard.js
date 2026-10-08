import { adminTokenExpiry, tokenExpiry, endSession } from './storage.js';

checkAuthAndRedirect();

function checkAuthAndRedirect() {
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    // damaged value: treated as signed out
  }
  if (!user) return (window.location.href = '/homepage.html');

  // Each page is for one role. A student must also hold a student token that has not expired.
  const path = window.location.pathname;
  if (path.endsWith('/student.html')) {
    if (user.role !== 'student') return window.location.replace('/homepage.html');
    const expiresAt = user.token ? tokenExpiry(user.token) : null;
    if (!expiresAt || expiresAt <= Date.now()) {
      try {
        sessionStorage.setItem('loginNotice', 'Please sign in again.');
      } catch {
        // storage blocked: no note on the login page
      }
      localStorage.removeItem('user');
      return window.location.replace('/login-page.html?role=student');
    }
  }
  if (path.endsWith('/faculty.html') && user.role !== 'faculty')
    return window.location.replace('/homepage.html');

  // The admin page also needs an admin token that has not expired yet
  if (window.location.pathname.endsWith('/admin.html')) {
    const expiresAt = user.adminToken ? adminTokenExpiry(user.adminToken) : null;
    if (!expiresAt) return endSession('Please sign in as admin to open this page.');
    if (expiresAt <= Date.now()) return endSession('Your admin session expired. Please sign in again.');
  }
}
