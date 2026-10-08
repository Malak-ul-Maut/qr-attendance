import { dbGet } from './db.js';
import { issueToken, readToken } from './auth-token.js';

// Not set by the answers so far; the plan assumed 12 hours.
export const STUDENT_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

export function issueStudentToken(username) {
  return issueToken('student', username, STUDENT_TOKEN_LIFETIME_SECONDS);
}

// Every /api/student/* route sits behind this. The student is always the one the token
// names, never something the request body or query says.
export async function requireStudent(req, res, next) {
  const { claims, error } = readToken(req);
  if (error === 'missing')
    return res.status(401).json({ ok: false, error: 'student_login_required' });
  if (error === 'expired')
    return res.status(401).json({ ok: false, error: 'expired_student_token' });
  if (error || claims.role !== 'student')
    return res.status(401).json({ ok: false, error: 'invalid_student_token' });

  try {
    const student = await dbGet(
      `SELECT id, username, name, roll_number, active FROM students WHERE username = ?`,
      [claims.username],
    );
    if (!student || !student.active)
      return res.status(403).json({ ok: false, error: 'account_inactive' });
    req.student = student;
    return next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'database_error' });
  }
}
