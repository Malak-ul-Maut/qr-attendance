import db from './db.js';
import { issueToken, readToken } from './auth-token.js';

const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

export function issueAdminToken(username) {
  return issueToken('admin', username, TOKEN_LIFETIME_SECONDS);
}

export function requireAdmin(req, res, next) {
  const { claims, error } = readToken(req);
  if (error === 'missing')
    return res.status(401).json({ ok: false, error: 'admin_login_required' });
  if (error === 'expired')
    return res.status(401).json({ ok: false, error: 'expired_admin_token' });
  // Tokens from before roles existed had no role and were admin-only.
  if (error || (claims.role ?? 'admin') !== 'admin')
    return res.status(401).json({ ok: false, error: 'invalid_admin_token' });

  db.get(
    `SELECT id FROM admins WHERE username = ?`,
    [claims.username],
    (dbError, admin) => {
      if (dbError) {
        console.error(dbError);
        return res.status(500).json({ ok: false, error: 'database_error' });
      }
      if (!admin) return res.status(403).json({ ok: false, error: 'admin_access_required' });
      req.adminUsername = claims.username;
      return next();
    },
  );
}
