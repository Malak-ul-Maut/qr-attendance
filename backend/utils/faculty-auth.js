import { issueToken, readToken } from './auth-token.js';

export const FACULTY_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export function issueFacultyToken(username) {
  return issueToken('faculty', username, FACULTY_TOKEN_LIFETIME_SECONDS);
}

// Returns the faculty username a bearer token names, or null. `token` is the bare string (as the socket receives it).
export function facultyUsernameFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const { claims } = readToken({ get: () => `Bearer ${token}` });
  return claims?.role === 'faculty' ? claims.username : null;
}

// For the few faculty routes that hand out QR codes. (The rest of the faculty routes still trust the request, as before.)
export function requireFaculty(req, res, next) {
  const { claims, error } = readToken(req);
  if (error === 'missing')
    return res.status(401).json({ ok: false, error: 'faculty_login_required' });
  if (error === 'expired')
    return res.status(401).json({ ok: false, error: 'expired_faculty_token' });
  if (error || claims.role !== 'faculty')
    return res.status(401).json({ ok: false, error: 'invalid_faculty_token' });
  req.facultyUsername = claims.username;
  return next();
}
