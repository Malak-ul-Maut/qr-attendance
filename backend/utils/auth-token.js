import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Signed login tokens for every role: "payload.signature", payload = base64url JSON
// { role, username, expiresAt (seconds) }. The role claim keeps a student token from
// ever being accepted as an admin token, and the other way round.
// ADMIN_SESSION_SECRET keeps tokens valid across restarts; otherwise a random secret is used.
const signingSecret = process.env.ADMIN_SESSION_SECRET || randomBytes(32);

export function issueToken(role, username, lifetimeSeconds) {
  const payload = Buffer.from(
    JSON.stringify({
      role,
      username,
      expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// Returns { claims } or { error: 'missing' | 'invalid' | 'expired' }.
export function readToken(req) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return { error: 'missing' };

  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length || !validSignature(payload, signature))
    return { error: 'invalid' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { error: 'invalid' };
  }
  if (!claims.username) return { error: 'invalid' };
  if (!(claims.expiresAt > Math.floor(Date.now() / 1000)))
    return { error: 'expired' };
  return { claims };
}

function sign(payload) {
  return createHmac('sha256', signingSecret).update(payload).digest('base64url');
}

function validSignature(payload, signature) {
  const expected = Buffer.from(sign(payload));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
