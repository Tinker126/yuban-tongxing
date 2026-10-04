import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { listScenarios } from '../src/scenarios.js';

const origin = 'http://localhost:3000';
const config = { origin, production: false, trustProxy: false, secret: 'scenario-test-secret-'.repeat(5),
  apiKey: 'test-only-key', model: 'deepseek-flash', dailyLimit: 1000 };
const users = {
  student: { id: '50000000-0000-4000-8000-000000000001', username: 'scenario_student', name: '测试学生', grade: 3, role: 'student' },
  admin: { id: '50000000-0000-4000-8000-000000000002', username: 'scenario_admin', name: '测试管理员', grade: null, role: 'admin' },
  other: { id: '50000000-0000-4000-8000-000000000003', username: 'other_student', name: '另一名学生', grade: 3, role: 'student' }
};
const tokens = { student: 's'.repeat(43), admin: 'a'.repeat(43), other: 'o'.repeat(43) };
const principals = new Map(Object.entries(tokens).map(([key, token]) => [createHash('sha256').update(token).digest('hex'), users[key]]));

class ScenarioPool {
  sessions = new Map();
  turns = new Map();

  async query(sql, values = []) {
    if (sql.includes('FROM auth_sessions JOIN users')) {
      const principal = principals.get(values[0]);
      return { rows: principal && (!sql.includes("users.role = 'student'") || principal.role === 'student') ? [principal] : [] };
    }
    if (sql.includes('INSERT INTO practice_sessions')) {
      const [id, studentId, topic, grade, sceneId, sceneTitle, progress] = values;
      this.sessions.set(id, { id, studentId, topic, grade, sceneId, sceneTitle, scenarioProgress: JSON.parse(progress),
        startedAt: new Date(), endedAt: null, durationSeconds: null, turnCount: 0, status: 'active', scenarioCompletedAt: null });
      return { rows: [] };
    }
    if (sql.includes('FROM practice_sessions WHERE id = $1 AND student_id = $2')) {
      const row = this.sessions.get(values[0]);
      if (!row || row.studentId !== values[1]) return { rows: [] };
      if (sql.includes('SELECT id, student_id, grade')) return { rows: [this.dbSession(row)] };
      if (sql.includes('SELECT id, grade, topic')) return { rows: [this.dbSession(row)] };
      return { rows: [this.apiSession(row)] };
    }
    if (sql.includes('SELECT count(*)::int AS total FROM practice_sessions WHERE')) {
      return { rows: [{ total: [...this.sessions.values()].filter(row => row.studentId === values[0]).length }] };
    }
    if (sql.includes('FROM practice_sessions WHERE student_id = $1')) {
      const rows = [...this.sessions.values()].filter(row => row.studentId === values[0]);
      const limit = values.at(-2), offset = values.at(-1);
      return { rows: rows.slice(offset, offset + limit).map(row => this.apiSession(row)) };
    }
    if (sql.includes('FROM practice_turns WHERE session_id = $1 ORDER BY turn_number')) {
      return { rows: this.listTurns(values[0]).map(turn => ({ turn_number: turn.turnNumber, student_text: turn.studentText,
        ai_reply: turn.aiReply, feedback: turn.feedback, input_mode: turn.inputMode, recognition_confidence: turn.confidence,
        created_at: turn.createdAt })) };
    }
    if (sql.includes('FROM practice_sessions ps JOIN users u') && sql.includes('WHERE ps.id = $1')) {
      const row = this.sessions.get(values[0]);
      return { rows: row ? [{ ...this.dbSession(row), student_name: users.student.name, username: users.student.username }] : [] };
    }
    throw new Error(`Unexpected scenario pool query: ${sql}`);
  }

  dbSession(row) {
    return { id: row.id, student_id: row.studentId, student_name: users.student.name, username: users.student.username,
      topic: row.topic, grade: row.grade, scene_id: row.sceneId, scene_title: row.sceneTitle,
      scenario_progress: row.scenarioProgress, scenario_completed_at: row.scenarioCompletedAt,
      started_at: row.startedAt, ended_at: row.endedAt, duration_seconds: row.durationSeconds,
      turn_count: row.turnCount, status: row.status };
  }

  apiSession(row) {
    const { student_id, ...rest } = this.dbSession(row);
    return rest;
  }

  listTurns(sessionId) {
    return [...this.turns.values()].filter(turn => turn.sessionId === sessionId).sort((a, b) => a.turnNumber - b.turnNumber);
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, values = []) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
        if (sql.includes('FOR UPDATE')) {
          const row = pool.sessions.get(values[0]);
          if (!row || row.studentId !== values[1]) return { rows: [] };
          return { rows: [{ id: row.id, status: row.status, turn_count: row.turnCount, grade: row.grade,
            scene_id: row.sceneId, scene_title: row.sceneTitle, scenario_progress: row.scenarioProgress,
            scenario_completed_at: row.scenarioCompletedAt, ended_at: row.endedAt, duration_seconds: row.durationSeconds }] };
        }
        if (sql.includes('FROM practice_turns WHERE session_id = $1 AND turn_number = $2')) {
          const turn = pool.turns.get(`${values[0]}:${values[1]}`);
          return { rows: turn ? [{ id: turn.id, student_text: turn.studentText, ai_reply: turn.aiReply,
            feedback: turn.feedback, input_mode: turn.inputMode, recognition_confidence: turn.confidence }] : [] };
        }
        if (sql.includes('INSERT INTO practice_turns')) {
          const [id, sessionId, turnNumber, studentText, aiReply, feedback, inputMode, confidence] = values;
          pool.turns.set(`${sessionId}:${turnNumber}`, { id, sessionId, turnNumber, studentText, aiReply,
            feedback: JSON.parse(feedback), inputMode, confidence, createdAt: new Date() });
          return { rows: [] };
        }
        if (sql.includes('UPDATE practice_sessions SET turn_count')) {
          pool.sessions.get(values[0]).turnCount = values[1]; return { rows: [] };
        }
        if (sql.includes('SET scenario_progress')) {
          const row = pool.sessions.get(values[0]); row.scenarioProgress = JSON.parse(values[1]);
          if (values[2]) row.scenarioCompletedAt ||= new Date();
          return { rows: [] };
        }
        if (sql.includes('SET ended_at = now()')) {
          const row = pool.sessions.get(values[0]);
          row.endedAt = new Date(); row.durationSeconds = 95; row.turnCount = pool.listTurns(row.id).length; row.status = 'completed';
          return { rows: [{ ended_at: row.endedAt, duration_seconds: row.durationSeconds, turn_count: row.turnCount }] };
        }
        if (sql.includes('SELECT student_text FROM practice_turns')) {
          return { rows: pool.listTurns(values[0]).map(turn => ({ student_text: turn.studentText })) };
        }
        throw new Error(`Unexpected scenario transaction query: ${sql}`);
      },
      release() {}
    };
  }
}

function deepSeekResponse(progress, reply = 'Hello! What would you like?') {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply,
    comment: { highlight: '你礼貌地表达了需要。', suggestion: '试着再询问一下价格。' }, progress }) } }] });
}

test('scenario catalog adapts difficulty, opening and target expressions to grades', () => {
  for (const grade of [3, 4, 5, 6]) {
    const scenes = listScenarios(grade);
    assert.equal(scenes.length, 6);
    assert.ok(scenes.every(scene => scene.grade === grade));
    assert.ok(scenes.every(scene => scene.openingMessage && scene.objective && scene.targetExpressions.length));
  }
  assert.match(listScenarios(3)[0].replyGuidance, /不超过8个单词/);
  assert.match(listScenarios(6)[0].replyGuidance, /不超过12个单词/);
  assert.notEqual(listScenarios(3)[0].openingMessage, listScenarios(6)[0].openingMessage);
});

test('scenario start, role-based AI progress, practice history and admin details use saved scene records', async t => {
  const pool = new ScenarioPool();
  const modelCalls = [];
  let callCount = 0;
  const fetchImpl = async (_url, options) => {
    modelCalls.push(JSON.parse(options.body));
    callCount++;
    const scene = listScenarios(3).find(item => item.id === 'restaurant-order');
    const progress = Object.fromEntries(scene.completionConditions.map(condition => [condition.id, callCount > 1]));
    return deepSeekResponse(progress, callCount === 1 ? 'Hello! What would you like?' : 'Great! Your order is ready.');
  };
  const app = createApp(config, {}, { dbPool: pool, fetchImpl });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', user = 'student', body } = {}) => fetch(base + route, {
    method,
    headers: { ...(user ? { cookie: `${user === 'admin' ? 'ybtc_admin' : 'ybtc_student'}=${tokens[user]}` } : {}),
      ...(body !== undefined ? { origin, 'x-requested-with': 'ybtc', 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  const home = await call('/', { user: null });
  assert.equal(home.status, 200);
  const homeMarkup = await home.text();
  assert.match(homeMarkup, /自由聊天/);
  assert.match(homeMarkup, /情景练习/);
  const grade3 = await (await call('/api/scenarios?grade=3', { user: null })).json();
  const grade6 = await (await call('/api/scenarios?grade=6', { user: null })).json();
  assert.deepEqual(grade3.scenes.map(scene => scene.id), ['meet-a-friend', 'school-talk', 'restaurant-order', 'shop-for-item', 'ask-directions', 'birthday-party']);
  assert.equal(grade3.scenes[2].difficulty, '入门');
  assert.equal(grade6.scenes[2].difficulty, '拓展');
  assert.equal((await call('/api/scenarios?grade=7', { user: null })).status, 400);
  assert.equal((await call('/api/practice/sessions', { method: 'POST', user: null, body: {} })).status, 401);
  assert.equal((await call('/api/practice/sessions', { method: 'POST', body: { grade: 3, topic: '餐厅点餐', sceneId: 'missing-scene', consent: true } })).status, 400);
  assert.equal((await call('/api/practice/sessions', { method: 'POST', body: { grade: 3, topic: '动物', sceneId: 'restaurant-order', consent: true } })).status, 400);

  const created = await call('/api/practice/sessions', { method: 'POST', body: {
    grade: 3, topic: '餐厅点餐', sceneId: 'restaurant-order', consent: true, student_id: users.admin.id, role: 'admin'
  } });
  assert.equal(created.status, 201);
  const { sessionId } = await created.json();
  const savedSession = pool.sessions.get(sessionId);
  assert.equal(savedSession.studentId, users.student.id);
  assert.equal(savedSession.sceneId, 'restaurant-order');
  assert.equal(savedSession.sceneTitle, '餐厅点餐');
  assert.equal(savedSession.turnCount, 0);

  const denied = await call(`/api/scenarios/restaurant-order/start`, { method: 'POST', user: null, body: { practiceSessionId: sessionId } });
  assert.equal(denied.status, 401);
  assert.equal((await call('/api/scenarios/restaurant-order/start', { method: 'POST', user: 'admin', body: { practiceSessionId: sessionId } })).status, 401);
  assert.equal((await call('/api/scenarios/restaurant-order/start', { method: 'POST', user: 'other', body: { practiceSessionId: sessionId } })).status, 404);
  assert.equal((await call('/api/scenarios/wrong-scene/start', { method: 'POST', body: { practiceSessionId: sessionId } })).status, 400);
  const startedResponse = await call('/api/scenarios/restaurant-order/start', { method: 'POST', body: { practiceSessionId: sessionId } });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  assert.match(started.opening, /what would you like/i);
  assert.equal(started.scene.studentRole, '顾客');
  assert.equal(started.scene.aiRole, '友善的服务员');

  const firstResponse = await call('/api/scenarios/chat', { method: 'POST', body: {
    sessionToken: started.sessionToken, history: [], text: 'Hello!', inputMode: 'text', confidence: null
  } });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.completed, false);
  assert.equal(Object.values(first.progress).every(value => value === false), true);
  assert.match(modelCalls[0].messages[0].content, /学生年级：3年级/);
  assert.match(modelCalls[0].messages[0].content, /学生身份：顾客/);
  assert.match(modelCalls[0].messages[0].content, /你的身份：友善的服务员/);
  assert.match(modelCalls[0].messages[0].content, /询问价格/);

  const saveTurn = (turnNumber, receipt) => call(`/api/practice/sessions/${sessionId}/turns`, {
    method: 'POST', body: { turnNumber, receipt }
  });
  assert.equal((await saveTurn(1, first.receipt)).status, 201);
  assert.equal((await saveTurn(1, first.receipt)).status, 200);
  assert.equal(pool.turns.size, 1);
  assert.equal((await call('/api/scenarios/chat', { method: 'POST', body: {
    sessionToken: started.sessionToken, history: [], text: 'stale history attempt', inputMode: 'text', confidence: null
  } })).status, 409);

  const secondResponse = await call('/api/scenarios/chat', { method: 'POST', body: {
    sessionToken: started.sessionToken, history: [first.receipt],
    text: 'I want an egg. Juice, please. How much? Thank you!', inputMode: 'text', confidence: null
  } });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(second.completed, true);
  assert.equal(second.remainingConditions.length, 0);
  assert.equal((await saveTurn(2, second.receipt)).status, 201);
  assert.equal(pool.sessions.get(sessionId).turnCount, 2);
  assert.equal(pool.sessions.get(sessionId).scenarioCompletedAt instanceof Date, true);

  const history = await (await call('/api/practice/sessions')).json();
  assert.equal(history.sessions[0].sceneId, 'restaurant-order');
  assert.equal(history.sessions[0].sceneTitle, '餐厅点餐');
  assert.equal(history.sessions[0].topic, '餐厅点餐');
  const detail = await (await call(`/api/practice/sessions/${sessionId}`)).json();
  assert.equal(detail.session.sceneTitle, '餐厅点餐');
  assert.deepEqual(detail.turns.map(turn => turn.turnNumber), [1, 2]);
  assert.equal(detail.turns[0].studentText, 'Hello!');
  assert.equal(detail.turns[1].studentText, 'I want an egg. Juice, please. How much? Thank you!');

  const adminDetailResponse = await call(`/api/admin/practice/sessions/${sessionId}`, { user: 'admin' });
  assert.equal(adminDetailResponse.status, 200);
  const adminDetail = await adminDetailResponse.json();
  assert.equal(adminDetail.session.sceneTitle, '餐厅点餐');
  assert.equal(adminDetail.session.scenarioProgress.ordered_food, true);
  assert.equal(adminDetail.turns[0].studentText, 'Hello!');

  const completionResponse = await call(`/api/practice/sessions/${sessionId}/complete`, { method: 'PATCH', body: {} });
  assert.equal(completionResponse.status, 200);
  const completion = await completionResponse.json();
  assert.equal(completion.status, 'completed');
  assert.equal(completion.scenario.completed, true);
  assert.equal(completion.turnCount, 2);
  assert.deepEqual(completion.scenario.usedExpressions, ['Hello!', 'I want an egg.', 'Juice, please.', 'How much?']);
});
