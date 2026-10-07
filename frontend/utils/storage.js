export function getCurrentUser() {
  const userData = localStorage.getItem('user');
  return userData ? JSON.parse(userData) : null;
}

export function logout() {
  localStorage.removeItem('user');
  window.location.href = '/homepage.html';
}

export function storeUser(data) {
  localStorage.setItem(
    'user',
    JSON.stringify({
      role: data.role,
      username: data.username,
      name: data.name,
      adminToken: data.adminToken || null,
      subName: data.subjectName,
      section: data.section,
    }),
  );
}

// ---------- Admin session helpers ----------
// The admin token is "payload.signature"; the payload says when it stops working.
// (Read only to show a clear message early. The server is still the one that decides.)
export function adminTokenExpiry(token) {
  try {
    const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    return Number(claims.expiresAt) * 1000 || null; // milliseconds
  } catch {
    return null;
  }
}

let endingSession = false;
// Signs the person out and sends them to the admin login with a short explanation.
export function endSession(message) {
  if (endingSession) return;
  endingSession = true;
  try {
    sessionStorage.setItem('loginNotice', message);
  } catch {
    // storage blocked: the login page just won't show the note
  }
  localStorage.removeItem('user');
  window.location.replace('/login-page.html?role=admin');
}
