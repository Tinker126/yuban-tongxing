import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { TOPICS } from './topics.js';
import { unseal } from './security.js';
import { findStudentSession } from './student-session.js';
import { findUsedExpressions, getScenario, listScenarios, normalizeScenarioProgress, scenarioCompleted, emptyScenarioProgress } from './scenarios.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_STATUSES = new Set(['active', 'completed', 'abandoned']);
const ALL_TOPICS = new Set(Object.values(TOPICS).flat());
const ALL_SCENE_TITLES = new Set(listScenarios(3).map(scene => scene.title));

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function unavailable() {
  const error = new Error('学习记录服务暂时不可用，请保留页面并稍后重试。');
  error.status = 503;
  return error;
}

function queryInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) badRequest(`${name}格式不正确。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) badRequest(`${name}超出允许范围。`);
  return number;
}

function validateReceipt(token, secret, practiceSessionId, studentId, turnNumber, session) {
  try {
    const turn = unseal(token, secret);
    const isScenario = turn.kind === 'scenario-turn';
    const scene = isScenario ? getScenario(session.scene_id, session.grade) : null;
    const progress = isScenario && scene ? normalizeScenarioProgress(turn.progress, scene, session.scenario_progress || emptyScenarioProgress(scene)) : null;
    if ((isScenario ? !scene || turn.sceneId !== session.scene_id || progress === null : turn.kind !== 'turn' || session.scene_id) ||
        turn.practiceSessionId !== practiceSessionId || turn.studentId !== studentId || turn.index !== turnNumber - 1 ||
        typeof turn.sessionId !== 'string' || typeof turn.student !== 'string' || typeof turn.reply !== 'string' ||
        typeof turn.comment?.highlight !== 'string' || typeof turn.comment?.suggestion !== 'string' ||
        !['speech', 'text'].includes(turn.inputMode) ||
        (turn.confidence !== null && (typeof turn.confidence !== 'number' || !Number.isFinite(turn.confidence) || turn.confidence < 0 || turn.confidence > 1))) {
      throw new Error('invalid receipt');
    }
    return isScenario ? { ...turn, progress } : turn;
  } catch {
    const error = new Error('对话回执无效，未保存本轮记录。');
    error.status = 400;
    throw error;
  }
}

export function createPracticeRouter(pool, config) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      const student = await findStudentSession(req, pool);
      if (!student) return res.status(401).json({ error: '请先登录学生账号。' });
      req.student = student;
      next();
    } catch (error) { next(error); }
  });

  router.post('/sessions', async (req, res) => {
    const { grade, topic, consent, sceneId } = req.body;
    const scene = sceneId === undefined ? null : getScenario(sceneId, grade);
    const validTopic = sceneId === undefined ? TOPICS[grade]?.includes(topic) : Boolean(scene && topic === scene.title);
    if (!Number.isInteger(grade) || !validTopic || consent !== true) badRequest('请选择年级、话题或有效情景，并阅读练习说明。');
    const id = randomUUID();
    try {
      await pool.query(
        `INSERT INTO practice_sessions (id, student_id, topic, grade, started_at, status, turn_count,
                                       scene_id, scene_title, scenario_progress)
         VALUES ($1, $2, $3, $4, now(), 'active', 0, $5, $6, $7::jsonb)`,
        [id, req.student.id, topic, grade, scene?.id || null, scene?.title || null, JSON.stringify(scene ? emptyScenarioProgress(scene) : {})]
      );
    } catch { throw unavailable(); }
    res.status(201).json({ sessionId: id });
  });

  router.get('/sessions', async (req, res) => {
    const limit = queryInteger(req.query.limit, 20, 1, 50, 'limit');
    const offset = queryInteger(req.query.offset, 0, 0, 100000, 'offset');
    const filters = [`student_id = $1`];
    const values = [req.student.id];
    if (req.query.status !== undefined) {
      if (typeof req.query.status !== 'string' || !SESSION_STATUSES.has(req.query.status)) badRequest('status筛选条件不正确。');
      values.push(req.query.status);
      filters.push(`status = $${values.length}`);
    }
    if (req.query.topic !== undefined) {
      if (typeof req.query.topic !== 'string' || (!ALL_TOPICS.has(req.query.topic) && !ALL_SCENE_TITLES.has(req.query.topic))) badRequest('topic筛选条件不正确。');
      values.push(req.query.topic);
      filters.push(`topic = $${values.length}`);
    }
    if (req.query.grade !== undefined) {
      const grade = queryInteger(req.query.grade, undefined, 3, 6, 'grade');
      values.push(grade);
      filters.push(`grade = $${values.length}`);
    }
    const where = filters.join(' AND ');
    try {
      const count = await pool.query(`SELECT count(*)::int AS total FROM practice_sessions WHERE ${where}`, values);
      const pageValues = [...values, limit, offset];
      const page = await pool.query(
        `SELECT id, topic, grade, started_at, ended_at, duration_seconds, turn_count, status, scene_id, scene_title, scenario_progress, scenario_completed_at
         FROM practice_sessions WHERE ${where}
         ORDER BY started_at DESC, id DESC
         LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
        pageValues
      );
      const total = count.rows[0].total;
      res.set('Cache-Control', 'no-store').json({
        sessions: page.rows.map(row => ({ id: row.id, topic: row.topic, sceneId: row.scene_id || null, sceneTitle: row.scene_title || null,
          scenarioProgress: row.scene_id ? row.scenario_progress : undefined, scenarioCompletedAt: row.scenario_completed_at || null,
          grade: row.grade, startedAt: row.started_at, endedAt: row.ended_at,
          durationSeconds: row.duration_seconds, turnCount: row.turn_count, status: row.status })),
        pagination: { limit, offset, total, hasMore: offset + page.rows.length < total }
      });
    } catch (error) {
      if (error.status) throw error;
      throw unavailable();
    }
  });

  router.get('/sessions/:sessionId', async (req, res) => {
    if (!UUID.test(req.params.sessionId)) return res.status(404).json({ error: '练习记录不存在。' });
    let result;
    try {
      result = await pool.query(
        `SELECT id, topic, grade, started_at, ended_at, duration_seconds, turn_count, status, scene_id, scene_title, scenario_progress, scenario_completed_at
         FROM practice_sessions WHERE id = $1 AND student_id = $2`,
        [req.params.sessionId, req.student.id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: '练习记录不存在。' });
      const turns = await pool.query(
        `SELECT turn_number, student_text, ai_reply, feedback, input_mode, recognition_confidence, created_at
         FROM practice_turns WHERE session_id = $1 ORDER BY turn_number`,
        [req.params.sessionId]
      );
      const row = result.rows[0];
      res.json({
        session: { id: row.id, topic: row.topic, sceneId: row.scene_id || null, sceneTitle: row.scene_title || null,
          scenarioProgress: row.scene_id ? row.scenario_progress : undefined, scenarioCompletedAt: row.scenario_completed_at || null,
          grade: row.grade, startedAt: row.started_at, endedAt: row.ended_at,
          durationSeconds: row.duration_seconds, turnCount: row.turn_count, status: row.status },
        turns: turns.rows.map(turn => ({ turnNumber: turn.turn_number, studentText: turn.student_text, aiReply: turn.ai_reply,
          feedback: turn.feedback, inputMode: turn.input_mode, recognitionConfidence: turn.recognition_confidence, createdAt: turn.created_at }))
      });
    } catch (error) {
      if (error.status) throw error;
      throw unavailable();
    }
  });

  router.post('/sessions/:sessionId/turns', async (req, res) => {
    const { sessionId } = req.params;
    if (!UUID.test(sessionId)) return res.status(404).json({ error: '练习记录不存在。' });
    const { turnNumber, receipt } = req.body;
    if (!Number.isInteger(turnNumber) || turnNumber < 1 || turnNumber > 30 || typeof receipt !== 'string' || receipt.length > 16000) {
      badRequest('本轮记录格式不正确。');
    }
    const client = await pool.connect().catch(() => { throw unavailable(); });
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `SELECT id, status, turn_count, grade, scene_id, scene_title, scenario_progress, scenario_completed_at FROM practice_sessions
         WHERE id = $1 AND student_id = $2 FOR UPDATE`,
        [sessionId, req.student.id]
      );
      const session = owned.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '练习记录不存在。' });
      }
      const turn = validateReceipt(receipt, config.secret, sessionId, req.student.id, turnNumber, session);
      if (!turn.student.trim() || turn.student.length > 600 || !turn.reply.trim() || turn.reply.length > 1000 ||
          !turn.comment.highlight.trim() || !turn.comment.suggestion.trim() || turn.comment.highlight.length > 120 || turn.comment.suggestion.length > 120) {
        badRequest('本轮内容格式不正确。');
      }
      const previous = await client.query(
        `SELECT id, student_text, ai_reply, feedback, input_mode, recognition_confidence
         FROM practice_turns WHERE session_id = $1 AND turn_number = $2`,
        [sessionId, turnNumber]
      );
      if (previous.rows[0]) {
        const existing = previous.rows[0];
        const same = existing.student_text === turn.student && existing.ai_reply === turn.reply &&
          JSON.stringify(existing.feedback) === JSON.stringify(turn.comment) && existing.input_mode === turn.inputMode &&
          (existing.recognition_confidence === null ? turn.confidence === null : Number(existing.recognition_confidence) === turn.confidence);
        await client.query('ROLLBACK');
        if (!same) return res.status(409).json({ error: '该轮次已保存为其他内容，不能覆盖。' });
        return res.json({ ok: true, duplicate: true, turnNumber });
      }
      if (session.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '本次练习已结束，不能继续保存。' });
      }
      if (turnNumber !== Number(session.turn_count) + 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '轮次顺序不正确，请先保存前面的对话。' });
      }
      await client.query(
        `INSERT INTO practice_turns
           (id, session_id, turn_number, student_text, ai_reply, feedback, input_mode, recognition_confidence)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [randomUUID(), sessionId, turnNumber, turn.student.trim(), turn.reply.trim(), JSON.stringify(turn.comment), turn.inputMode, turn.confidence]
      );
      await client.query('UPDATE practice_sessions SET turn_count = $2 WHERE id = $1', [sessionId, turnNumber]);
      if (turn.kind === 'scenario-turn') {
        const scene = getScenario(session.scene_id, session.grade);
        const isComplete = scenarioCompleted(turn.progress, scene);
        await client.query(
          `UPDATE practice_sessions SET scenario_progress = $2::jsonb,
             scenario_completed_at = CASE WHEN $3 THEN COALESCE(scenario_completed_at, now()) ELSE scenario_completed_at END
           WHERE id = $1`,
          [sessionId, JSON.stringify(turn.progress), isComplete]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ ok: true, duplicate: false, turnNumber });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.status) throw error;
      throw unavailable();
    } finally { client.release(); }
  });

  router.patch('/sessions/:sessionId/complete', async (req, res) => {
    const { sessionId } = req.params;
    if (!UUID.test(sessionId)) return res.status(404).json({ error: '练习记录不存在。' });
    const client = await pool.connect().catch(() => { throw unavailable(); });
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `SELECT id, status, ended_at, duration_seconds, turn_count, grade, scene_id, scene_title, scenario_progress, scenario_completed_at FROM practice_sessions
         WHERE id = $1 AND student_id = $2 FOR UPDATE`,
        [sessionId, req.student.id]
      );
      const session = owned.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '练习记录不存在。' });
      }
      if (session.status === 'completed') {
        await client.query('ROLLBACK');
        const scenario = session.scene_id ? await scenarioCompletionSummary(client, session) : null;
        return res.json({ ok: true, status: 'completed', endedAt: session.ended_at, durationSeconds: session.duration_seconds,
          turnCount: session.turn_count, ...(scenario ? { scenario } : {}) });
      }
      if (session.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '本次练习不能结束。' });
      }
      const completed = await client.query(
        `UPDATE practice_sessions
         SET ended_at = now(),
             duration_seconds = GREATEST(0, floor(extract(epoch FROM (now() - started_at)))::integer),
             turn_count = (SELECT count(*) FROM practice_turns WHERE session_id = $1),
             status = 'completed'
         WHERE id = $1 AND student_id = $2
         RETURNING ended_at, duration_seconds, turn_count`,
        [sessionId, req.student.id]
      );
      const scenario = session.scene_id ? await scenarioCompletionSummary(client, session) : null;
      await client.query('COMMIT');
      const row = completed.rows[0];
      res.json({ ok: true, status: 'completed', endedAt: row.ended_at, durationSeconds: row.duration_seconds,
        turnCount: row.turn_count, ...(scenario ? { scenario } : {}) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.status) throw error;
      throw unavailable();
    } finally { client.release(); }
  });

  return router;
}

async function scenarioCompletionSummary(client, session) {
  const scene = getScenario(session.scene_id, session.grade);
  if (!scene) return null;
  const progress = normalizeScenarioProgress(session.scenario_progress || {}, scene) || emptyScenarioProgress(scene);
  const turns = await client.query('SELECT student_text FROM practice_turns WHERE session_id = $1 ORDER BY turn_number', [session.id]);
  return {
    sceneId: scene.id, sceneTitle: session.scene_title || scene.title,
    completed: scenarioCompleted(progress, scene), progress,
    completedConditions: scene.completionConditions.filter(condition => progress[condition.id]),
    targetExpressions: scene.targetExpressions,
    usedExpressions: findUsedExpressions(scene.targetExpressions, turns.rows.map(turn => turn.student_text))
  };
}
