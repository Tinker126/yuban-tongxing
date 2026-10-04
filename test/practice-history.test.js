import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';
import { formatDuration, formatGrade, formatStatus } from '../public/history-format.js';

test('history summary formats the verified five-turn session values clearly', () => {
  assert.equal(formatDuration(788), '13分08秒');
  assert.equal(formatGrade(3), '3年级');
  assert.equal(formatStatus('completed'), '已完成');
});

const origin = 'http://localhost:3000';
const config = { origin, production: false, trustProxy: false, secret: 'h'.repeat(96), adminUsername: 'teacher',
  adminHash: hashPassword('correct-password-for-tests'), apiKey: 'test-only-key', model: 'deepseek-flash', maxRecords: 100,
  maxBytes: 4 * 1024 * 1024, dailyLimit: 1000 };
const ids = { A: '10000000-0000-4000-8000-00000000000a', B: '10000000-0000-4000-8000-00000000000b' };
const sessionIds = {
  aNew: '20000000-0000-4000-8000-000000000001',
  aOld: '20000000-0000-4000-8000-000000000002',
  bOnly: '20000000-0000-4000-8000-000000000003'
};
const tokens = { A: 'a'.repeat(43), B: 'b'.repeat(43) };
const hashToUser = new Map(Object.entries(tokens).map(([key, token]) => [
  createHash('sha256').update(token).digest('hex'), { id: ids[key], username: `student_${key.toLowerCase()}`, name: `Student ${key}`, grade: 3, role: 'student' }
]));

class HistoryPool {
  sessions = [
    { id: sessionIds.aNew, student_id: ids.A, topic: '动物', grade: 3, started_at: new Date('2026-09-29T02:00:00Z'), ended_at: new Date('2026-09-29T02:04:00Z'), duration_seconds: 240, turn_count: 1, status: 'completed' },
    { id: sessionIds.aOld, student_id: ids.A, topic: '问候与介绍', grade: 3, started_at: new Date('2026-09-28T02:00:00Z'), ended_at: null, duration_seconds: null, turn_count: 0, status: 'active' },
    { id: sessionIds.bOnly, student_id: ids.B, topic: '我的教室', grade: 4, started_at: new Date('2026-09-29T03:00:00Z'), ended_at: null, duration_seconds: null, turn_count: 0, status: 'active' }
  ];
  turns = [{ session_id: sessionIds.aNew, turn_number: 1, student_text: 'I like cats.', ai_reply: 'Cats are lovely!', feedback: { highlight: '你说出了喜欢的动物。', suggestion: '再说说它是什么颜色。' }, input_mode: 'speech', recognition_confidence: 0.9, created_at: new Date('2026-09-29T02:01:00Z') }];

  async query(sql, values = []) {
    if (sql.includes('FROM auth_sessions JOIN users')) return { rows: hashToUser.has(values[0]) ? [hashToUser.get(values[0])] : [] };
    if (sql.includes('FROM practice_sessions WHERE id = $1 AND student_id = $2')) {
      const row = this.sessions.find(session => session.id === values[0] && session.student_id === values[1]);
      return { rows: row ? [{ id: row.id, topic: row.topic, grade: row.grade, started_at: row.started_at, ended_at: row.ended_at,
        duration_seconds: row.duration_seconds, turn_count: row.turn_count, status: row.status }] : [] };
    }
    if (sql.includes('FROM practice_turns WHERE session_id = $1 ORDER BY turn_number')) {
      return { rows: this.turns.filter(turn => turn.session_id === values[0]).sort((a, b) => a.turn_number - b.turn_number) };
    }
    if (sql.includes('FROM practice_sessions WHERE student_id = $1')) {
      let rows = this.sessions.filter(session => session.student_id === values[0]);
      for (const field of ['status', 'topic', 'grade']) {
        const match = sql.match(new RegExp(`${field} = \\$(\\d+)`));
        if (match) rows = rows.filter(session => String(session[field]) === String(values[Number(match[1]) - 1]));
      }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ total: rows.length }] };
      rows.sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id));
      const [, limitIndex, offsetIndex] = sql.match(/LIMIT \$(\d+) OFFSET \$(\d+)/);
      const limit = values[Number(limitIndex) - 1], offset = values[Number(offsetIndex) - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    throw new Error(`Unexpected history query: ${sql}`);
  }
}

test('student history is paginated, filterable, private, and returns ordered details', async t => {
  const pool = new HistoryPool();
  const app = createApp(config, {}, { dbPool: pool });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(route, user) {
    return fetch(base + route, { headers: user ? { cookie: `ybtc_student=${tokens[user]}` } : {} });
  }

  assert.equal((await get('/api/practice/sessions')).status, 401);
  assert.equal((await get(`/api/practice/sessions/${sessionIds.aNew}`)).status, 401);
  assert.equal((await get(`/history/${sessionIds.aNew}`)).status, 200);

  const first = await get(`/api/practice/sessions?student_id=${ids.B}&limit=1`, 'A');
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control') || '', /no-store/);
  const firstPage = await first.json();
  assert.equal(firstPage.pagination.total, 2);
  assert.equal(firstPage.pagination.hasMore, true);
  assert.equal(firstPage.sessions[0].id, sessionIds.aNew);
  assert.equal(Object.hasOwn(firstPage.sessions[0], 'studentId'), false);
  assert.equal(firstPage.sessions[0].durationSeconds, 240);
  assert.equal(firstPage.sessions[0].turnCount, 1);

  const secondPage = await get('/api/practice/sessions?limit=1&offset=1', 'A');
  assert.equal((await secondPage.json()).sessions[0].id, sessionIds.aOld);
  const filtered = await get('/api/practice/sessions?status=completed&topic=%E5%8A%A8%E7%89%A9&grade=3', 'A');
  assert.deepEqual((await filtered.json()).sessions.map(session => session.id), [sessionIds.aNew]);
  assert.equal((await get('/api/practice/sessions?limit=999', 'A')).status, 400);
  assert.equal((await get('/api/practice/sessions?status=other', 'A')).status, 400);

  const ownDetail = await get(`/api/practice/sessions/${sessionIds.aNew}`, 'A');
  assert.equal(ownDetail.status, 200);
  const details = await ownDetail.json();
  assert.equal(details.session.id, sessionIds.aNew);
  assert.equal(details.turns[0].turnNumber, 1);
  assert.equal(details.turns[0].studentText, 'I like cats.');
  assert.equal((await get(`/api/practice/sessions/${sessionIds.bOnly}`, 'A')).status, 404);
  assert.equal((await get(`/api/practice/sessions/${sessionIds.aNew}`, 'B')).status, 404);
  const bHistory = await get('/api/practice/sessions', 'B');
  assert.deepEqual((await bHistory.json()).sessions.map(session => session.id), [sessionIds.bOnly]);
});
