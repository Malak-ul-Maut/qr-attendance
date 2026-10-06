import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import db from './db.js';

const signingSecret = process.env.ADMIN_SESSION_SECRET || randomBytes(32);
const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

export function issueAdminToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ username, expiresAt: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function requireAdmin(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, error: 'admin_login_required' });

  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length || !validSignature(payload, signature)) {
    return res.status(401).json({ ok: false, error: 'invalid_admin_token' });
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid_admin_token' });
  }

  if (!claims.username || claims.expiresAt <= Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ ok: false, error: 'expired_admin_token' });
  }

  db.get(
    `SELECT id FROM admins WHERE username = ?`,
    [claims.username],
    (error, admin) => {
      if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }
      if (!admin) return res.status(403).json({ ok: false, error: 'admin_access_required' });
      req.adminUsername = claims.username;
      return next();
    },
  );
}

function sign(payload) {
  return createHmac('sha256', signingSecret).update(payload).digest('base64url');
}

function validSignature(payload, signature) {
  const expected = Buffer.from(sign(payload));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}