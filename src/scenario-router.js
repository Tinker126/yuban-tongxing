import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { digest, seal, unseal } from './security.js';
import { findStudentSession } from './student-session.js';
import { emptyScenarioProgress, getScenario, listScenarios, makeScenarioPrompt, normalizeScenarioProgress, scenarioCompleted } from './scenarios.js';
import { fetchWithTimeout } from '../public/fetch-with-timeout.js';

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function studentText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 600) fail(400, '学生文本格式不正确。');
  return value.trim();
}

function readScenarioSession(token, secret) {
  try {
    const session = unseal(token, secret);
    if (session.kind !== 'scenario-practice' || session.expires < Date.now() || !UUID.test(session.practiceSessionId) ||
        typeof session.id !== 'string' || typeof session.studentId !== 'string' || !getScenario(session.sceneId, session.grade)) throw new Error();
    return session;
  } catch { fail(400, '情景练习凭证无效或已过期，请重新开始。'); }
}

function readScenarioHistory(history, session, scene, secret) {
  if (!Array.isArray(history) || history.length > 30) fail(400, '每次练习最多30轮。');
  return history.map((token, index) => {
    try {
      const turn = unseal(token, secret);
      const progress = normalizeScenarioProgress(turn.progress, scene);
      if (turn.kind !== 'scenario-turn' || turn.sessionId !== session.id || turn.practiceSessionId !== session.practiceSessionId ||
          turn.studentId !== session.studentId || turn.sceneId !== scene.id || turn.index !== index ||
          turn.previous !== (index ? digest(history[index - 1]) : '') || typeof turn.student !== 'string' ||
          typeof turn.reply !== 'string' || typeof turn.comment?.highlight !== 'string' || typeof turn.comment?.suggestion !== 'string' ||
          !['speech', 'text'].includes(turn.inputMode) || progress === null ||
          (turn.confidence !== null && (typeof turn.confidence !== 'number' || !Number.isFinite(turn.confidence) || turn.confidence < 0 || turn.confidence > 1))) throw new Error();
      return { ...turn, progress };
    } catch { fail(400, '情景对话历史校验失败，请重新开始本次练习。'); }
  });
}

function validateModelOutput(output, scene, previousProgress) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.reply !== 'string' ||
      !output.reply.trim() || output.reply.length > 1000 || !/[a-z]/i.test(output.reply) || /[\u4e00-\u9fff]/u.test(output.reply) ||
      typeof output.comment?.highlight !== 'string' || typeof output.comment?.suggestion !== 'string' ||
      !output.comment.highlight.trim() || !output.comment.suggestion.trim() || output.comment.highlight.length > 120 || output.comment.suggestion.length > 120) {
    fail(502, '情景回复格式不完整，请再试一次。');
  }
  const supplied = output.progress;
  const keys = scene.completionConditions.map(condition => condition.id);
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
      Object.keys(supplied).length !== keys.length || keys.some(key => typeof supplied[key] !== 'boolean') ||
      Object.keys(supplied).some(key => !keys.includes(key))) fail(502, '情景任务进度格式不完整，请再试一次。');
  return {
    reply: output.reply.trim(),
    comment: { highlight: output.comment.highlight.trim(), suggestion: output.comment.suggestion.trim() },
    progress: normalizeScenarioProgress(supplied, scene, previousProgress)
  };
}

export function createScenarioRouter(pool, config, { fetchImpl = fetch } = {}) {
  const router = Router();
  let day = '', requestsToday = 0, inflight = 0;
  const chatLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: '情景练习稍慢一点，请一分钟后继续。' } });

  router.get('/', (req, res) => {
    const grade = Number(req.query.grade);
    if (!Number.isInteger(grade) || grade < 3 || grade > 6 || String(grade) !== String(req.query.grade)) return res.status(400).json({ error: '请选择3至6年级。' });
    res.set('Cache-Control', 'no-store').json({ scenes: listScenarios(grade) });
  });

  router.post('/:sceneId/start', async (req, res, next) => {
    try {
      const student = await findStudentSession(req, pool);
      if (!student) return res.status(401).json({ error: '请先登录学生账号。' });
      const practiceSessionId = req.body.practiceSessionId;
      if (typeof practiceSessionId !== 'string' || !UUID.test(practiceSessionId)) return res.status(400).json({ error: '练习记录无效，请重新开始。' });
      let row;
      try {
        const result = await pool.query(
          `SELECT id, grade, topic, scene_id, scene_title, scenario_progress, status
           FROM practice_sessions WHERE id = $1 AND student_id = $2`,
          [practiceSessionId, student.id]
        );
        row = result.rows[0];
      } catch { return res.status(503).json({ error: '学习记录服务暂时不可用，请稍后重试。' }); }
      if (!row || row.status !== 'active') return res.status(404).json({ error: '练习记录不存在或已结束，请重新开始。' });
      const scene = getScenario(req.params.sceneId, row.grade);
      if (!scene || row.scene_id !== scene.id || row.topic !== scene.title) return res.status(400).json({ error: '情景与本次练习记录不匹配。' });
      const session = { kind: 'scenario-practice', id: randomUUID(), studentId: student.id, practiceSessionId,
        grade: row.grade, sceneId: scene.id, startTime: new Date().toISOString(), expires: Date.now() + DAY };
      res.set('Cache-Control', 'no-store').json({ sessionId: session.id, sessionToken: seal(session, config.secret),
        practiceSessionId, scene, opening: scene.openingMessage, progress: row.scenario_progress || emptyScenarioProgress(scene) });
    } catch (error) { next(error); }
  });

  router.post('/chat', chatLimit, async (req, res, next) => {
    try {
      const studentSession = await findStudentSession(req, pool);
      if (!studentSession) return res.status(401).json({ error: '请先登录学生账号。' });
      const session = readScenarioSession(req.body.sessionToken, config.secret);
      if (session.studentId !== studentSession.id) return res.status(404).json({ error: '情景练习不存在。' });
      const scene = getScenario(session.sceneId, session.grade);
      const history = readScenarioHistory(req.body.history, session, scene, config.secret);
      if (history.length >= 30) return res.status(409).json({ error: '已完成30轮，请结束并保存本次练习。' });
      const text = studentText(req.body.text);
      const { inputMode, confidence } = req.body;
      if (!['speech', 'text'].includes(inputMode) ||
          (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) ||
          (inputMode === 'text' && confidence !== null)) return res.status(400).json({ error: '输入方式或置信度不正确。' });
      if (!config.apiKey || config.apiKey.startsWith('replace-')) return res.status(503).json({ error: '老师还没有配置AI服务，请稍后再来。' });
      const today = new Date().toISOString().slice(0, 10);
      if (day !== today) { day = today; requestsToday = 0; }
      if (requestsToday >= config.dailyLimit) return res.status(429).json({ error: '今天的练习服务额度已用完，请明天再来。' });
      if (inflight >= 8) return res.status(503).json({ error: '现在练习的小伙伴较多，请稍后再试。' });

      let practice;
      try {
        const result = await pool.query(
          `SELECT id, student_id, grade, topic, scene_id, scenario_progress, status, turn_count
           FROM practice_sessions WHERE id = $1 AND student_id = $2`,
          [session.practiceSessionId, studentSession.id]
        );
        practice = result.rows[0];
      } catch { return res.status(503).json({ error: '学习记录服务暂时不可用，请稍后重试。' }); }
      if (!practice || practice.status !== 'active' || practice.scene_id !== scene.id || practice.grade !== scene.grade || practice.topic !== scene.title) {
        return res.status(404).json({ error: '情景练习不存在或已结束。' });
      }
      if (history.length < Number(practice.turn_count || 0)) return res.status(409).json({ error: '情景记录正在同步，请稍后再试。' });
      const previousProgress = normalizeScenarioProgress(history.at(-1)?.progress || {}, scene,
        practice.scenario_progress || emptyScenarioProgress(scene)) || emptyScenarioProgress(scene);
      const messages = [
        { role: 'system', content: makeScenarioPrompt(scene, previousProgress) },
        { role: 'assistant', content: scene.openingMessage },
        ...history.flatMap(turn => [
          { role: 'user', content: turn.student },
          { role: 'assistant', content: JSON.stringify({ reply: turn.reply, comment: turn.comment }) }
        ]),
        { role: 'user', content: text }
      ];
      let output;
      requestsToday++; inflight++;
      try {
        const response = await fetchWithTimeout(fetchImpl, 'https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, messages, stream: false, thinking: { type: 'disabled' },
            response_format: { type: 'json_object' }, max_tokens: 650, temperature: 0.5 })
        });
        if (!response.ok) return res.status(502).json({ error: response.status === 429 ? 'AI服务繁忙，请稍后重试。' : 'AI服务暂时不可用，请联系老师检查配置或余额。' });
        const data = await response.json();
        if (data.choices?.[0]?.finish_reason !== 'stop') return res.status(502).json({ error: 'AI回复未完整生成，请重试。' });
        try { output = validateModelOutput(JSON.parse(data.choices[0].message.content), scene, previousProgress); }
        catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); return res.status(502).json({ error: '情景回复格式不完整，请再试一次。' }); }
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        return res.status(502).json({ error: error.name === 'TimeoutError' ? 'AI回答超时了，请稍后重试。' : '暂时连接不到AI服务，请稍后重试。' });
      } finally { inflight--; }
      const turn = { kind: 'scenario-turn', sessionId: session.id, practiceSessionId: session.practiceSessionId,
        studentId: session.studentId, sceneId: scene.id, index: history.length,
        previous: req.body.history.length ? digest(req.body.history.at(-1)) : '', student: text,
        reply: output.reply, comment: output.comment, progress: output.progress, confidence, inputMode, time: new Date().toISOString() };
      const completed = scenarioCompleted(turn.progress, scene);
      res.set('Cache-Control', 'no-store').json({ reply: turn.reply, comment: turn.comment, progress: turn.progress,
        completed, completedConditions: scene.completionConditions.filter(item => turn.progress[item.id]),
        remainingConditions: scene.completionConditions.filter(item => !turn.progress[item.id]),
        receipt: seal(turn, config.secret), time: turn.time });
    } catch (error) { next(error); }
  });

  return router;
}
