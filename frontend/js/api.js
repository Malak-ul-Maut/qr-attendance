// Calls to /api/student/*. Sends the student token and always resolves to an object
// (never throws), in the same shape as postJson: { ok, status, error, ...body }.
// A 401 means the token is missing, wrong or expired, so the student is sent to sign in again.
import { getCurrentUser } from '../utils/storage.js';

function signOut() {
  localStorage.removeItem('user');
  try {
    sessionStorage.setItem('loginNotice', 'Please sign in again.');
  } catch {
    // storage blocked: the login page just won't show the note
  }
  window.location.replace('/login-page.html?role=student');
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getCurrentUser()?.token;
  if (!token) {
    signOut();
    return { ok: false, status: 401, error: 'student_login_required' };
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    console.error('API request failed', error);
    return { ok: false, status: 0, error: 'network' };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // not JSON (for example an HTML error page)
  }
  if (response.status === 401) {
    signOut();
    return { ok: false, status: 401, error: data?.error || 'invalid_student_token' };
  }
  // /face/template returns a bare array, everything else an object
  if (response.ok && Array.isArray(data)) return { ok: true, status: response.status, data };
  if (response.ok && data && data.ok !== false) return { ...data, ok: true, status: response.status };
  return {
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}),
    ok: false,
    status: response.status,
    error: data?.error || (response.status >= 500 ? 'server_error' : 'unknown'),
  };
}

export const apiGet = path => api(path);
export const apiPost = (path, body) => api(path, { method: 'POST', body });
