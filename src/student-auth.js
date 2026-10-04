import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { verifyPassword } from './security.js';

const scryptAsync = promisify(scrypt);
const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'ybtc_student';
const LOGIN_ERROR = '账号或密码不正确。';
const registerLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '操作太频繁，请15分钟后再试。' }
});
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: req => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    return /^[a-z0-9_]{3,32}$/.test(username) ? `user:${username}` : `invalid:${ipKeyGenerator(req.ip)}`;
  },
  message: { error: '登录尝试过多，请15分钟后再试。' }
});

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function usernameFrom(value) {
  if (typeof value !== 'string') badRequest('账号格式不正确。');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) badRequest('账号须为3至32位小写字母、数字或下划线。');
  return username;
}

function passwordFrom(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || Buffer.byteLength(value, 'utf8') > 256) {
    badRequest('密码须为8至128个字符。');
  }
  return value;
}

function studentCookie(token, config) {
  return {
    httpOnly: true,
    secure: config.production === true,
    sameSite: 'lax',
    path: '/',
    ...(token ? { maxAge: SESSION_AGE_MS } : {})
  };
}

function readToken(req) {
  const cookie = (req.headers.cookie || '').split(';').find(part => part.trim().startsWith(`${COOKIE_NAME}=`));
  const token = cookie?.trim().slice(COOKIE_NAME.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(row) {
  return { id: row.id, username: row.username, name: row.name, grade: row.grade, role: row.role };
}

export function createStudentAuthRouter(pool, config) {
  const router = Router();

  router.use((req, res, next) => {
    if (!pool || typeof pool.query !== 'function') return res.status(503).json({ error: '学生账号服务暂时不可用。' });
    next();
  });

  router.post('/register', registerLimit, async (req, res) => {
    const username = usernameFrom(req.body.username);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) badRequest('称呼须为1至80个字符，不能包含控制字符。');
    const password = passwordFrom(req.body.password);
    const grade = req.body.grade;
    if (!Number.isInteger(grade) || grade < 3 || grade > 6) badRequest('请选择3至6年级。');

    const salt = randomBytes(16).toString('hex');
    const hash = `scrypt:${salt}:${(await scryptAsync(password, salt, 64)).toString('hex')}`;
    try {
      const result = await pool.query(
        `INSERT INTO users (id, username, name, password_hash, grade, role)
         VALUES ($1, $2, $3, $4, $5, 'student')
         RETURNING id, username, name, grade, role`,
        [randomUUID(), username, name, hash, grade]
      );
      res.status(201).json(publicUser(result.rows[0]));
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'users_username_key') {
        return res.status(409).json({ error: '该账号已被使用，请更换账号。' });
      }
      throw error;
    }
  });

  router.post('/login', loginLimit, async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = req.body.password;
    if (!/^[a-z0-9_]{3,32}$/.test(username) || typeof password !== 'string' || !password || password.length > 128 || Buffer.byteLength(password, 'utf8') > 256) {
      return res.status(401).json({ error: LOGIN_ERROR });
    }

    const result = await pool.query(
      "SELECT id, username, name, grade, role, password_hash FROM users WHERE username = $1 AND role = 'student'",
      [username]
    );
    const user = result.rows[0];
    if (!user) {
      // Spend similar password-hashing time for unknown and existing accounts.
      await scryptAsync(password, Buffer.alloc(16), 64);
      return res.status(401).json({ error: LOGIN_ERROR });
    }
    let valid = false;
    try { valid = await verifyPassword(password, user.password_hash); }
    catch { /* Do not expose hash format or account state to the client. */ }
    if (!valid) return res.status(401).json({ error: LOGIN_ERROR });

    const previous = readToken(req);
    if (previous) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(previous)]);
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      'INSERT INTO auth_sessions (id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tokenHash(token), user.id, new Date(Date.now() + SESSION_AGE_MS)]
    );
    res.cookie(COOKIE_NAME, token, studentCookie(token, config));
    res.json(publicUser(user));
  });

  router.get('/me', async (req, res) => {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: '未登录。' });
    const result = await pool.query(
      `SELECT users.id, users.username, users.name, users.grade, users.role
       FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now() AND users.role = 'student'`,
      [tokenHash(token)]
    );
    if (!result.rows[0]) return res.status(401).json({ error: '未登录或登录已过期。' });
    res.json(publicUser(result.rows[0]));
  });

  router.post('/logout', async (req, res) => {
    const token = readToken(req);
    if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
    res.clearCookie(COOKIE_NAME, studentCookie(null, config));
    res.json({ ok: true });
  });

  return router;
}
