import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';

const origin = 'http://localhost:3000';
const config = { origin, production: false, trustProxy: false, secret: 'p'.repeat(96), adminUsername: 'teacher',
  adminHash: hashPassword('correct-password-for-tests'), apiKey: 'test-only-key', model: 'deepseek-flash', maxRecords: 100,
  maxBytes: 4 * 1024 * 1024, dailyLimit: 1000 };
const ids = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b'
};
const tokens = { A: 'a'.repeat(43), B: 'b'.repeat(43) };
const usersByHash = new Map(Object.entries(tokens).map(([key, token]) => [createHash('sha256').update(token).digest('hex'), { id: ids[key], username: `student_${key.toLowerCase()}`, name: `Student ${key}`, grade: 3, role: 'student' }]));

class PracticeMemoryPool {
  sessions = new Map();
  turns = new Map();

  async query(sql, values = []) {
    if (sql.includes('FROM auth_sessions JOIN users')) return { rows: usersByHash.has(values[0]) ? [usersByHash.get(values[0])] : [] };
    if (sql.includes('INSERT INTO practice_sessions')) {
      this.sessions.set(values[0], { id: values[0], studentId: values[1], topic: values[2], grade: values[3], startedAt: new Date(), status: 'active', turnCount: 0, endedAt: null, durationSeconds: null });
      return { rows: [] };
    }
    if (sql.includes('SELECT id FROM practice_sessions')) {
      const row = this.sessions.get(values[0]);
      return { rows: row && row.studentId === values[1] && row.grade === values[2] && row.topic === values[3] && row.status === 'active' ? [{ id: row.id }] : [] };
    }
    if (sql.includes('FROM practice_sessions WHERE id = $1 AND student_id = $2')) {
      const row = this.sessions.get(values[0]);
      if (!row || row.studentId !== values[1]) return { rows: [] };
      return { rows: [{ id: row.id, topic: row.topic, grade: row.grade, started_at: row.startedAt, ended_at: row.endedAt,
        duration_seconds: row.durationSeconds, turn_count: row.turnCount, status: row.status }] };
    }
    if (sql.includes('FROM practice_turns WHERE session_id = $1 ORDER BY turn_number')) {
      const rows = [...this.turns.values()].filter(row => row.sessionId === values[0]).sort((a, b) => a.turnNumber - b.turnNumber);
      return { rows: rows.map(row => ({ turn_number: row.turnNumber, student_text: row.studentText, ai_reply: row.aiReply,
        feedback: row.feedback, input_mode: row.inputMode, recognition_confidence: row.confidence, created_at: row.createdAt })) };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }

  async connect() {
    const pool = this;
    return {
      async query(sql, values = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM practice_sessions') && sql.includes('FOR UPDATE')) {
          const row = pool.sessions.get(values[0]);
          if (!row || row.studentId !== values[1]) return { rows: [] };
          if (sql.includes('ended_at')) return { rows: [{ id: row.id, status: row.status, ended_at: row.endedAt, duration_seconds: row.durationSeconds, turn_count: row.turnCount }] };
          return { rows: [{ id: row.id, status: row.status, turn_count: row.turnCount }] };
        }
        if (sql.includes('FROM practice_turns WHERE session_id = $1 AND turn_number = $2')) {
          const row = pool.turns.get(`${values[0]}:${values[1]}`);
          return { rows: row ? [{ id: row.id, student_text: row.studentText, ai_reply: row.aiReply, feedback: row.feedback,
            input_mode: row.inputMode, recognition_confidence: row.confidence }] : [] };
        }
        if (sql.includes('INSERT INTO practice_turns')) {
          const [id, sessionId, turnNumber, studentText, aiReply, feedback, inputMode, confidence] = values;
          pool.turns.set(`${sessionId}:${turnNumber}`, { id, sessionId, turnNumber, studentText, aiReply, feedback: JSON.parse(feedback), inputMode, confidence, createdAt: new Date() });
          return { rows: [] };
        }
        if (sql.includes('UPDATE practice_sessions SET turn_count')) {
          const row = pool.sessions.get(values[0]); row.turnCount = values[1]; return { rows: [] };
        }
        if (sql.includes("SET ended_at = now()")) {
          const row = pool.sessions.get(values[0]);
          row.endedAt = new Date(); row.durationSeconds = 5; row.turnCount = [...pool.turns.values()].filter(turn => turn.sessionId === values[0]).length; row.status = 'completed';
          return { rows: [{ ended_at: row.endedAt, duration_seconds: row.durationSeconds, turn_count: row.turnCount }] };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() {}
    };
  }
}

test('auth-bound practice turns are server-signed, ordered, idempotent, and owner-only', async t => {
  const pool = new PracticeMemoryPool();
  const app = createApp(config, {}, { dbPool: pool, fetchImpl: async () => Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: 'That sounds fun! Do you play every day?', comment: { highlight: '你清楚地说出了喜欢的活动。', suggestion: '试着再说一个原因。' } }) } }]
  }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(route, { method = 'GET', user = 'A', body } = {}) {
    return fetch(base + route, {
      method,
      headers: {
        cookie: `ybtc_student=${tokens[user]}`,
        ...(body !== undefined ? { 'content-type': 'application/json', origin, 'x-requested-with': 'ybtc' } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  }

  const create = await call('/api/practice/sessions', { method: 'POST', body: { grade: 3, topic: '动物', consent: true, student_id: ids.B } });
  assert.equal(create.status, 201);
  const { sessionId } = await create.json();
  assert.equal(pool.sessions.get(sessionId).studentId, ids.A);
  const bind = await call('/api/startSession', { method: 'POST', body: { grade: 3, topic: '动物', consent: true, practiceSessionId: sessionId } });
  assert.equal(bind.status, 200);
  const chat = await bind.json();
  const response = await call('/api/chat', { method: 'POST', body: { sessionToken: chat.sessionToken, history: [], grade: 3, topic: '动物', text: 'I like cats.', inputMode: 'text', confidence: null } });
  assert.equal(response.status, 200);
  const signed = await response.json();

  const save = () => call(`/api/practice/sessions/${sessionId}/turns`, { method: 'POST', body: { turnNumber: 1, receipt: signed.receipt } });
  assert.equal((await save()).status, 201);
  const duplicate = await save();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(pool.turns.size, 1);
  assert.equal(pool.sessions.get(sessionId).turnCount, 1);

  assert.equal((await call(`/api/practice/sessions/${sessionId}/turns`, { method: 'POST', user: 'B', body: { turnNumber: 1, receipt: signed.receipt } })).status, 404);
  assert.equal((await call(`/api/practice/sessions/${sessionId}`, { user: 'B' })).status, 404);
  assert.equal((await call(`/api/practice/sessions/${sessionId}/complete`, { method: 'PATCH', user: 'B', body: {} })).status, 404);
  assert.equal((await call(`/api/practice/sessions/${sessionId}/complete`, { method: 'PATCH', body: {} })).status, 200);
  assert.equal(pool.sessions.get(sessionId).status, 'completed');
  assert.equal(pool.sessions.get(sessionId).turnCount, 1);
  assert.equal((await call(`/api/practice/sessions/${sessionId}`)).status, 200);
});
