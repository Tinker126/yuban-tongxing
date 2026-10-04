import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOPICS, STARTERS, makePrompt } from './topics.js';
import { seal, unseal, digest } from './security.js';
import { createStudentAuthRouter } from './student-auth.js';
import { createPracticeRouter } from './practice-router.js';
import { createScenarioRouter } from './scenario-router.js';
import { createSpeechRouter } from './speech-router.js';
import { findStudentSession } from './student-session.js';
import { createAdminRouter, findSessionPrincipal } from './admin-router.js';
import { fetchWithTimeout } from '../public/fetch-with-timeout.js';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const adminPage = fileURLToPath(new URL('../views/admin.html', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${name}格式不正确。`);
  return value.trim();
}
export function createApp(config, store, { fetchImpl = fetch, dbPool, speechOptions } = {}) {
  const app = express();
  let day = '', requestsToday = 0, inflight = 0;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
    frameAncestors: ["'none'"], upgradeInsecureRequests: config.production ? [] : null
  } }, strictTransportSecurity: config.production ? undefined : false }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), on-device-speech-recognition=(self)');
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').status(200).json({ ok: true }));
  app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '操作太频繁，请稍后再试。' } }));
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PATCH') {
      if (req.get('origin') !== config.origin || req.get('x-requested-with') !== 'ybtc') return res.status(403).json({ error: '请求来源不正确，请通过配置的网站地址访问。' });
    }
    next();
  });
  // Only this authenticated, bounded route accepts temporary audio. All existing
  // APIs retain their JSON-only contract and the same origin/cookie protection.
  app.use('/api/speech', createSpeechRouter(dbPool, config, speechOptions));
  app.use('/api', (req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PATCH') && !req.is('application/json')) {
      return res.status(415).json({ error: '此接口仅接收JSON文本。' });
    }
    next();
  });
  app.use(express.json({ limit: '512kb', strict: true }));
  app.use('/api', (req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PATCH') && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: '请求必须是JSON对象。' });
    next();
  });
  app.use('/api/auth', createStudentAuthRouter(dbPool, config));
  app.use('/api/practice', createPracticeRouter(dbPool, config));
  app.use('/api/scenarios', createScenarioRouter(dbPool, config, { fetchImpl }));
  app.use('/api', createAdminRouter(dbPool, config, store));
  function readSession(token) {
    try {
      const session = unseal(token, config.secret);
      if (session.kind !== 'practice' || session.expires < Date.now() || !TOPICS[session.grade]?.includes(session.topic) ||
          typeof session.studentId !== 'string' || typeof session.practiceSessionId !== 'string') throw new Error();
      return session;
    } catch { fail(400, '练习凭证无效或已过期，请重新开始。'); }
  }
  function readHistory(history, session) {
    if (!Array.isArray(history) || history.length > 30) fail(400, '每次练习最多30轮。');
    return history.map((token, i) => {
      try {
        const turn = unseal(token, config.secret);
        if (turn.kind !== 'turn' || turn.sessionId !== session.id || turn.index !== i || turn.previous !== (i ? digest(history[i-1]) : '')) throw new Error();
        return turn;
      } catch { fail(400, '对话历史校验失败，请勿修改练习数据。'); }
    });
  }
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/topics', (req, res) => res.json({ topics: TOPICS, starters: STARTERS, maxRounds: 30 }));
  app.post('/api/startSession', rateLimit({ windowMs: 60000, limit: 20, legacyHeaders: false }), async (req, res) => {
    const { grade, topic, consent, practiceSessionId } = req.body;
    if (!Number.isInteger(grade) || !TOPICS[grade]?.includes(topic) || consent !== true) fail(400, '请选择年级、话题，并阅读练习说明。');
    if (typeof practiceSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(practiceSessionId)) fail(400, '练习记录无效，请重新开始。');
    const student = await findStudentSession(req, dbPool);
    if (!student) fail(401, '请先登录学生账号。');
    let owned;
    try {
      owned = await dbPool.query(
        `SELECT id FROM practice_sessions
         WHERE id = $1 AND student_id = $2 AND grade = $3 AND topic = $4 AND status = 'active'`,
        [practiceSessionId, student.id, grade, topic]
      );
    } catch { fail(503, '学习记录服务暂时不可用，请稍后重试。'); }
    if (!owned.rows[0]) fail(404, '练习记录不存在或已结束，请重新开始。');
    const startTime = new Date().toISOString();
    const session = { kind: 'practice', id: randomUUID(), studentId: student.id, practiceSessionId, grade, topic, startTime, expires: Date.now()+DAY };
    res.json({ sessionId: session.id, startTime, sessionToken: seal(session, config.secret), opening: STARTERS[topic] });
  });
  app.post('/api/chat', rateLimit({ windowMs: 60000, limit: 30, legacyHeaders: false, message: { error: '稍慢一点，请一分钟后继续。' } }), async (req, res) => {
    const { sessionToken, history, grade, topic, confidence, inputMode } = req.body;
    const session = readSession(sessionToken);
    if (grade !== session.grade || topic !== session.topic) fail(400, '年级或话题与当前练习不一致。');
    const turns = readHistory(history, session);
    if (turns.length >= 30) fail(400, '已完成30轮，请结束并保存本次练习。');
    const student = text(req.body.text, 600, '学生文本');
    if (!['speech', 'text'].includes(inputMode) || (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) || (inputMode === 'text' && confidence !== null)) fail(400, '输入方式或置信度不正确。');
    if (!config.apiKey || config.apiKey.startsWith('replace-')) fail(503, '老师还没有配置AI服务，请稍后再来。');
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) { day = today; requestsToday = 0; }
    if (requestsToday >= config.dailyLimit) fail(429, '今天的练习服务额度已用完，请明天再来。');
    if (inflight >= 8) fail(503, '现在练习的小伙伴较多，请稍后再试。');
    const messages = [
      { role: 'system', content: makePrompt(grade, topic) },
      { role: 'assistant', content: STARTERS[topic] },
      ...turns.flatMap(t => [{ role: 'user', content: t.student }, { role: 'assistant', content: JSON.stringify({ reply: t.reply, comment: t.comment }) }]),
      { role: 'user', content: student }
    ];
    requestsToday++; inflight++;
    let output;
    try {
      const response = await fetchWithTimeout(fetchImpl, 'https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 500, temperature: 0.6 })
      });
      if (!response.ok) fail(502, response.status === 429 ? 'AI服务繁忙，请稍后重试。' : 'AI服务暂时不可用，请联系老师检查配置或余额。');
      const data = await response.json();
      if (data.choices?.[0]?.finish_reason !== 'stop') fail(502, 'AI回复未完整生成，请重试。');
      try {
        output = JSON.parse(data.choices[0].message.content);
        if (typeof output.reply !== 'string' || !output.reply.trim() || output.reply.length > 1000 || !/[a-z]/i.test(output.reply) || /[\u4e00-\u9fff]/u.test(output.reply) || typeof output.comment?.highlight !== 'string' || typeof output.comment?.suggestion !== 'string' || !output.comment.highlight.trim() || !output.comment.suggestion.trim() || output.comment.highlight.length > 120 || output.comment.suggestion.length > 120) throw new Error();
      } catch { fail(502, 'AI回复格式不完整，请再试一次。'); }
    } catch (e) {
      if (e.status) throw e;
      fail(502, e.name === 'TimeoutError' ? 'AI回答超时了，请稍后重试。' : '暂时连接不到AI服务，请稍后重试。');
    } finally { inflight--; }
    const turn = { kind: 'turn', sessionId: session.id, practiceSessionId: session.practiceSessionId, studentId: session.studentId, index: turns.length, previous: history.length ? digest(history.at(-1)) : '', student, reply: output.reply.trim(), comment: { highlight: output.comment.highlight.trim(), suggestion: output.comment.suggestion.trim() }, confidence, inputMode, time: new Date().toISOString() };
    res.json({ reply: turn.reply, comment: turn.comment, receipt: seal(turn, config.secret), time: turn.time });
  });
  app.post('/api/saveChat', async (req, res) => {
    if (config.production) return res.status(410).json({ error: '旧版本地归档接口已停用，请使用学生练习记录功能。' });
    const session = readSession(req.body.sessionToken);
    const verified = readHistory(req.body.history, session);
    if (!verified.length) fail(400, '完成至少一轮对话后才能保存。');
    const turns = verified.map(({ student, reply, comment, confidence, inputMode, time }) => ({ student, reply, comment, confidence, inputMode, time }));
    // Store only allowlisted text fields. Ignore client-supplied timestamps, AI text and extra fields.
    const record = {
      schemaVersion: 1, sessionId: session.id, startTime: session.startTime,
      endTime: new Date().toISOString(), grade: session.grade, topic: session.topic,
      studentTexts: turns.map(t => t.student), aiReplies: turns.map(t => t.reply),
      aiComments: turns.map(t => t.comment), rounds: turns.length,
      recognitionConfidences: turns.map(t => t.confidence), turns,
      contentHash: digest(JSON.stringify(turns)), consentVersion: '2026-09-28'
    };
    const result = await store.append(record);
    res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, sessionId: record.sessionId, endTime: result.record.endTime });
  });
  app.get('/admin/login', (req, res) => res.sendFile(`${publicDir}/login.html`));
  app.get(['/admin', '/admin/'], async (req, res, next) => {
    try {
      const user = await findSessionPrincipal(req, dbPool);
      if (!user) return res.redirect('/admin/login');
      if (user.role !== 'admin') return res.status(403).send('当前账号没有管理员权限。');
      return res.set('Cache-Control', 'no-store').sendFile(adminPage);
    } catch (error) { next(error); }
  });
  app.get('/register', (req, res) => res.sendFile(`${publicDir}/register.html`));
  app.get('/login', (req, res) => res.sendFile(`${publicDir}/student-login.html`));
  app.get(['/history', '/history/'], (req, res) => res.set('Cache-Control', 'no-store').sendFile(`${publicDir}/history.html`));
  app.get('/history/:sessionId', (req, res) => res.set('Cache-Control', 'no-store').sendFile(`${publicDir}/history.html`));
  // Do not expose an alternate static path around the administrator page guard.
  app.get(['/admin.html', '/login.html'], (req, res) => res.sendStatus(404));
  app.use(express.static(publicDir, { dotfiles: 'deny', index: 'index.html' }));
  app.use((req, res) => res.status(404).json({ error: '页面或接口不存在。' }));
  app.use((e, req, res, next) => {
    if (res.headersSent) return next(e);
    const status = e.type === 'entity.too.large' ? 413 : (e instanceof SyntaxError && 'body' in e ? 400 : e.status || 500);
    // Never log request bodies, transcripts, upstream responses, tokens or secrets.
    if (status >= 500) console.error(`[request failure] ${req.method} ${req.path} status=${status}`);
    res.status(status).json({ error: status === 413 ? '提交内容过大。' : status === 500 ? '服务暂时不可用，请稍后重试。' : e instanceof SyntaxError ? 'JSON格式不正确。' : e.message });
  });
  return app;
}
