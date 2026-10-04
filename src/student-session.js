import { createHash } from 'node:crypto';

const COOKIE_NAME = 'ybtc_student';

function tokenFromRequest(req) {
  const cookie = (req.headers.cookie || '').split(';').find(part => part.trim().startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.trim().slice(COOKIE_NAME.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function findStudentSession(req, pool) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  if (!pool || typeof pool.query !== 'function') {
    const error = new Error('学生账号服务暂时不可用。');
    error.status = 503;
    throw error;
  }

  try {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await pool.query(
      `SELECT users.id, users.username, users.name, users.grade, users.role
       FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now() AND users.role = 'student'`,
      [tokenHash]
    );
    return result.rows[0] || null;
  } catch {
    const error = new Error('学生账号服务暂时不可用。');
    error.status = 503;
    throw error;
  }
}
