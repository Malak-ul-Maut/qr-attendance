export default async function postData(url, dataObject) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dataObject),
    });
    return response.json();
  } catch (error) {
    console.error('POST request error:', error);
  }
}

// Like postData, but always returns an object and never throws:
//   { ok: true, ...body }                       the server accepted it
//   { ok: false, status, error, ...body }       the server refused it (error is a code)
//   { ok: false, status: 0, error: 'network' }  the request never reached the server
// A 500 with an HTML body becomes { ok: false, status: 500, error: 'server_error' }.
export async function postJson(url, dataObject) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dataObject),
    });
  } catch (error) {
    console.error('POST request error:', error);
    return { ok: false, status: 0, error: 'network' };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // not JSON (for example an HTML error page)
  }
  if (response.ok && body && body.ok !== false) return { ...body, ok: true };
  return {
    ...(body && typeof body === 'object' ? body : {}),
    ok: false,
    status: response.status,
    error:
      (body && body.error) || (response.status >= 500 ? 'server_error' : 'unknown'),
  };
}
