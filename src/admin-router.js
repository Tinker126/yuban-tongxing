import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { verifyPassword } from './security.js';
import { csvRows } from './csv.js';

const scryptAsync = promisify(scrypt);
const ADMIN_COOKIE = 'ybtc_admin';
const STUDENT_COOKIE = 'ybtc_student';
const SESSION_AGE_MS = 8 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOGIN_ERROR = '账号或密码不正确。';

function cookieToken(req, cookieName) {
  const value = (req.headers.cookie || '').split(';').find(part => part.trim().startsWith(`${cookieName}=`))?.trim().slice(cookieName.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function adminCookie(config, token) {
  return {
    httpOnly: true,
    secure: config.production === true,
    sameSite: 'lax',
    path: '/',
    ...(token ? { maxAge: SESSION_AGE_MS } : {})
  };
}

export async function findSessionPrincipal(req, pool) {
  if (!pool || typeof pool.query !== 'function') {
    const error = new Error('管理员账号服务暂时不可用。');
    error.status = 503;
    throw error;
  }
  const token = cookieToken(req, ADMIN_COOKIE) || cookieToken(req, STUDENT_COOKIE);
  if (!token) return null;
  const result = await pool.query(
    `SELECT users.id, users.username, users.name, users.grade, users.role
     FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now()`,
    [tokenHash(token)]
  );
  return result.rows[0] || null;
}

export function requireAdmin(pool) {
  return async (req, res, next) => {
    try {
      const user = await findSessionPrincipal(req, pool);
      if (!user) return res.status(401).json({ error: '请先登录管理员账号。' });
      if (user.role !== 'admin') return res.status(403).json({ error: '当前账号没有管理员权限。' });
      req.admin = { id: user.id, username: user.username, name: user.name };
      next();
    } catch (error) { next(error); }
  };
}

function queryInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    const error = new Error(`${name}格式不正确。`); error.status = 400; throw error;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const error = new Error(`${name}超出允许范围。`); error.status = 400; throw error;
  }
  return number;
}

function cleanSummaryRow(row) {
  return {
    id: row.id, studentId: row.student_id, studentName: row.student_name, username: row.username,
    topic: row.topic, ...(row.scene_id ? { sceneId: row.scene_id, sceneTitle: row.scene_title } : {}),
    grade: row.grade, startedAt: row.started_at, endedAt: row.ended_at,
    durationSeconds: row.duration_seconds, turnCount: row.turn_count, status: row.status
  };
}

export function createAdminRouter(pool, config, store) {
  const router = Router();
  const guard = requireAdmin(pool);
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: req => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      return /^[a-z0-9_]{3,32}$/.test(username) ? `admin:${username}` : `invalid:${ipKeyGenerator(req.ip)}`;
    },
    message: { error: '登录尝试过多，请15分钟后再试。' }
  });

  async function login(req, res) {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = req.body.password;
    if (!/^[a-z0-9_]{3,32}$/.test(username) || typeof password !== 'string' || !password || password.length > 128 || Buffer.byteLength(password, 'utf8') > 256) {
      return res.status(401).json({ error: LOGIN_ERROR });
    }
    if (!pool || typeof pool.query !== 'function') return res.status(503).json({ error: '管理员账号服务暂时不可用。' });
    const result = await pool.query(
      "SELECT id, username, name, grade, role, password_hash FROM users WHERE username = $1 AND role = 'admin'",
      [username]
    );
    const user = result.rows[0];
    if (!user) {
      await scryptAsync(password, Buffer.alloc(16), 64);
      return res.status(401).json({ error: LOGIN_ERROR });
    }
    let valid = false;
    try { valid = await verifyPassword(password, user.password_hash); }
    catch { /* Keep malformed hashes and unknown accounts indistinguishable. */ }
    if (!valid) return res.status(401).json({ error: LOGIN_ERROR });

    const previous = cookieToken(req, ADMIN_COOKIE);
    if (previous) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(previous)]);
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      'INSERT INTO auth_sessions (id, token_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tokenHash(token), user.id, new Date(Date.now() + SESSION_AGE_MS)]
    );
    res.cookie(ADMIN_COOKIE, token, adminCookie(config, token));
    res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  }

  router.post(['/admin/login', '/adminLogin'], loginLimit, login);
  router.get(['/admin/me', '/adminMe'], guard, (req, res) => res.json(req.admin));
  router.post(['/admin/logout', '/adminLogout'], guard, async (req, res) => {
    const token = cookieToken(req, ADMIN_COOKIE);
    if (token) await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash(token)]);
    res.clearCookie(ADMIN_COOKIE, adminCookie(config, null));
    res.json({ ok: true });
  });

  router.get('/admin/summary', guard, async (req, res) => {
    const [students, totals, recent] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM users WHERE role = 'student'"),
      pool.query(
        `SELECT
           count(*)::int AS total_sessions,
           count(*) FILTER (
             WHERE (ps.started_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
           )::int AS today_sessions,
           count(DISTINCT ps.student_id) FILTER (
             WHERE (ps.started_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
           )::int AS today_students,
           COALESCE(sum(ps.duration_seconds), 0)::bigint AS total_duration_seconds
         FROM practice_sessions ps JOIN users u ON u.id = ps.student_id
         WHERE u.role = 'student'`
      ),
      pool.query(
        `SELECT ps.id, ps.student_id, u.name AS student_name, u.username,
                ps.topic, ps.scene_id, ps.scene_title, ps.grade, ps.started_at, ps.ended_at, ps.duration_seconds, ps.turn_count, ps.status
         FROM practice_sessions ps JOIN users u ON u.id = ps.student_id
         WHERE u.role = 'student'
         ORDER BY ps.started_at DESC, ps.id DESC LIMIT 20`
      )
    ]);
    const totalsRow = totals.rows[0];
    res.set('Cache-Control', 'no-store').json({
      studentCount: students.rows[0].count,
      todayPracticeUsers: totalsRow.today_students,
      todayPracticeSessions: totalsRow.today_sessions,
      totalPracticeSessions: totalsRow.total_sessions,
      totalDurationSeconds: Number(totalsRow.total_duration_seconds),
      recentSessions: recent.rows.map(cleanSummaryRow)
    });
  });

  router.get('/admin/students', guard, async (req, res) => {
    const limit = queryInteger(req.query.limit, 20, 1, 50, 'limit');
    const offset = queryInteger(req.query.offset, 0, 0, 100000, 'offset');
    const [count, rows] = await Promise.all([
      pool.query("SELECT count(*)::int AS total FROM users WHERE role = 'student'"),
      pool.query(
        `SELECT u.id, u.name, u.username, u.grade,
                COALESCE(p.total_sessions, 0)::int AS total_sessions,
                COALESCE(p.total_duration_seconds, 0)::bigint AS total_duration_seconds,
                p.last_practice_at
         FROM users u
         LEFT JOIN LATERAL (
           SELECT count(*) AS total_sessions,
                  sum(duration_seconds) AS total_duration_seconds,
                  max(started_at) AS last_practice_at
           FROM practice_sessions WHERE student_id = u.id
         ) p ON true
         WHERE u.role = 'student'
         ORDER BY p.last_practice_at DESC NULLS LAST, u.created_at DESC, u.id
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )
    ]);
    const total = count.rows[0].total;
    res.set('Cache-Control', 'no-store').json({
      students: rows.rows.map(row => ({ id: row.id, name: row.name, username: row.username, grade: row.grade,
        totalPracticeSessions: row.total_sessions, totalDurationSeconds: Number(row.total_duration_seconds), lastPracticeAt: row.last_practice_at })),
      pagination: { limit, offset, total, hasMore: offset + rows.rows.length < total }
    });
  });

  router.get('/admin/students/:studentId', guard, async (req, res) => {
    if (!UUID.test(req.params.studentId)) return res.status(404).json({ error: '学生不存在。' });
    const studentResult = await pool.query(
      "SELECT id, username, name, grade, created_at, updated_at FROM users WHERE id = $1 AND role = 'student'",
      [req.params.studentId]
    );
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: '学生不存在。' });
    const limit = queryInteger(req.query.limit, 50, 1, 100, 'limit');
    const offset = queryInteger(req.query.offset, 0, 0, 100000, 'offset');
    const [summary, count, sessions] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total_sessions,
                COALESCE(sum(duration_seconds), 0)::bigint AS total_duration_seconds,
                COALESCE(sum(turn_count), 0)::bigint AS total_turn_count,
                max(started_at) AS last_practice_at
         FROM practice_sessions WHERE student_id = $1`,
        [student.id]
      ),
      pool.query('SELECT count(*)::int AS total FROM practice_sessions WHERE student_id = $1', [student.id]),
      pool.query(
        `SELECT id, topic, scene_id, scene_title, grade, started_at, ended_at, duration_seconds, turn_count, status
         FROM practice_sessions WHERE student_id = $1
         ORDER BY started_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [student.id, limit, offset]
      )
    ]);
    const totals = summary.rows[0];
    const total = count.rows[0].total;
    res.set('Cache-Control', 'no-store').json({
      student: { id: student.id, username: student.username, name: student.name, grade: student.grade,
        createdAt: student.created_at, updatedAt: student.updated_at },
      stats: { totalPracticeSessions: totals.total_sessions, totalDurationSeconds: Number(totals.total_duration_seconds),
        totalTurnCount: Number(totals.total_turn_count), lastPracticeAt: totals.last_practice_at },
      sessions: sessions.rows.map(row => ({ id: row.id, topic: row.topic, sceneId: row.scene_id || null, sceneTitle: row.scene_title || null,
        grade: row.grade, startedAt: row.started_at,
        endedAt: row.ended_at, durationSeconds: row.duration_seconds, turnCount: row.turn_count, status: row.status })),
      pagination: { limit, offset, total, hasMore: offset + sessions.rows.length < total }
    });
  });

  router.get('/admin/practice/sessions/:sessionId', guard, async (req, res) => {
    if (!UUID.test(req.params.sessionId)) return res.status(404).json({ error: '练习记录不存在。' });
    const result = await pool.query(
      `SELECT ps.id, ps.student_id, u.name AS student_name, u.username,
              ps.topic, ps.scene_id, ps.scene_title, ps.scenario_progress, ps.scenario_completed_at,
              ps.grade, ps.started_at, ps.ended_at, ps.duration_seconds, ps.turn_count, ps.status
       FROM practice_sessions ps JOIN users u ON u.id = ps.student_id
       WHERE ps.id = $1 AND u.role = 'student'`,
      [req.params.sessionId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: '练习记录不存在。' });
    const turns = await pool.query(
      `SELECT turn_number, student_text, ai_reply, feedback, created_at
       FROM practice_turns WHERE session_id = $1 ORDER BY turn_number`,
      [row.id]
    );
    res.set('Cache-Control', 'no-store').json({
      session: { id: row.id, studentId: row.student_id, studentName: row.student_name, username: row.username,
        topic: row.topic, sceneId: row.scene_id || null, sceneTitle: row.scene_title || null,
        scenarioProgress: row.scene_id ? row.scenario_progress : undefined,
        scenarioCompletedAt: row.scenario_completed_at || null,
        grade: row.grade, startedAt: row.started_at, endedAt: row.ended_at,
        durationSeconds: row.duration_seconds, turnCount: row.turn_count, status: row.status },
      turns: turns.rows.map(turn => ({ turnNumber: turn.turn_number, studentText: turn.student_text,
        aiReply: turn.ai_reply, feedback: turn.feedback, createdAt: turn.created_at }))
    });
  });

  // Compatibility routes for the earlier anonymous-research JSON archive remain admin-only.
  router.get('/getAllData', guard, async (req, res) => {
    if (!store || typeof store.read !== 'function') return res.status(503).json({ error: '旧版匿名数据服务暂时不可用。' });
    const records = await store.read();
    const counts = {};
    for (const record of records) {
      const key = `${record.grade}年级 · ${record.topic}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    res.json({ records: records.toReversed(), stats: { totalSessions: records.length,
      totalRounds: records.reduce((sum, record) => sum + record.rounds, 0), topics: counts } });
  });
  router.get('/exportCsv', guard, async (req, res) => {
    if (!store || typeof store.read !== 'function') return res.status(503).json({ error: '旧版匿名数据服务暂时不可用。' });
    const records = await store.read();
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="yuban-chat-${new Date().toISOString().slice(0, 10)}.csv"`, 'X-Content-Type-Options': 'nosniff' });
    const stream = Readable.from(csvRows(records));
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  return router;
}
