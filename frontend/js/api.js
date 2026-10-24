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

// A POST that reports how much has been sent, for the photo upload (fetch cannot do that). Same result shape as api():
// { ok, status, error, ...body }, never throws. Gives up when nothing has moved for `stallMs`, or after `maxMs` in all.
//   onProgress(fraction 0..1, sentBytes, totalBytes)
export function apiUpload(path, body, { onProgress = () => {}, stallMs = 30000, maxMs = 300000 } = {}) {
  const token = getCurrentUser()?.token;
  if (!token) {
    signOut();
    return Promise.resolve({ ok: false, status: 401, error: 'student_login_required' });
  }
  const payload = JSON.stringify(body);
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    let stall = 0;
    let hardStop = 0;
    let finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      clearTimeout(stall);
      clearTimeout(hardStop);
      resolve(result);
    };
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => { xhr.abort(); done({ ok: false, status: 0, error: 'timeout' }); }, stallMs);
    };
    xhr.open('POST', window.apiUrl ? window.apiUrl(path) : path);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = event => {
      armStall();
      if (event.lengthComputable) onProgress(event.loaded / event.total, event.loaded, event.total);
    };
    xhr.upload.onload = () => { onProgress(1, payload.length, payload.length); armStall(); }; // all sent; the server is working
    xhr.onerror = () => done({ ok: false, status: 0, error: 'network' });
    xhr.onabort = () => done({ ok: false, status: 0, error: 'network' });
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON (an HTML error page) */ }
      if (xhr.status === 401) { signOut(); return done({ ok: false, status: 401, error: data?.error || 'invalid_student_token' }); }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok !== false) return done({ ...data, ok: true, status: xhr.status });
      done({ ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}), ok: false, status: xhr.status, error: data?.error || (xhr.status >= 500 ? 'server_error' : 'unknown') });
    };
    armStall();
    hardStop = setTimeout(() => { xhr.abort(); done({ ok: false, status: 0, error: 'timeout' }); }, maxMs);
    xhr.send(payload);
  });
}
