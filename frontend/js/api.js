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

// The inline script in student.html's <head> stores promises in window.__early[path]. One use each, 20 s at most.
function takeEarly(path) {
  const entry = window.__early?.[path];
  if (!entry) return null;
  delete window.__early[path];
  return performance.now() - entry.at < 20000 ? entry.promise : null;
}

// timeoutMs: give up on a request that has not finished after this long (0 = wait for ever). A stalled upload on a weak
// mobile connection would otherwise leave the spinner turning for ever.
export async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
  const token = getCurrentUser()?.token;
  if (!token) {
    signOut();
    return { ok: false, status: 401, error: 'student_login_required' };
  }
  let response;
  try {
    // student.html starts /me and /schedule while the scripts are still loading. Use that answer once, if it is fresh.
    const early = method === 'GET' ? takeEarly(path) : null;
    if (early) response = await early.catch(() => null); // a failed early try is simply repeated below
    if (!response)
      response = await fetch(path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
  } catch (error) {
    console.error('API request failed', error);
    return { ok: false, status: 0, error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
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
export const apiPost = (path, body, options = {}) => api(path, { method: 'POST', body, ...options });
