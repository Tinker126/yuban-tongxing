import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';
import { loadConfig } from '../src/config.js';

const origin = 'http://localhost:3000';
const adminId = '30000000-0000-4000-8000-000000000001';
const studentAId = '30000000-0000-4000-8000-000000000002';
const studentBId = '30000000-0000-4000-8000-000000000003';
const practiceId = '40000000-0000-4000-8000-000000000001';
const adminToken = 'a'.repeat(43), studentToken = 'b'.repeat(43);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const passwordHash = hashPassword('admin-test-password');
const students = [
  { id: studentAId, username: 'student_a', name: 'Student A', grade: 3, created_at: new Date('2026-09-20T00:00:00Z'), updated_at: new Date('2026-09-20T00:00:00Z') },
  { id: studentBId, username: 'student_b', name: 'Student B', grade: 4, created_at: new Date('2026-09-21T00:00:00Z'), updated_at: new Date('2026-09-21T00:00:00Z') }
];
const session = { id: practiceId, student_id: studentAId, student_name: 'Student A', username: 'student_a', topic: '问候与介绍', grade: 3,
  started_at: new Date('2026-09-29T01:00:00Z'), ended_at: new Date('2026-09-29T01:13:08Z'), duration_seconds: 788, turn_count: 5, status: 'completed' };
const turns = Array.from({ length: 5 }, (_, index) => ({ turn_number: index + 1, student_text: `Test student text ${index + 1}`,
  ai_reply: `Test AI reply ${index + 1}`, feedback: { highlight: '测试点评亮点', suggestion: '测试改进建议' }, created_at: new Date(`2026-09-29T01:0${index}:00Z`) }));

test('server config does not require an administrator username or password value', () => {
  const config = loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 's'.repeat(48), APP_ORIGIN: origin });
  assert.equal(config.origin, origin);
  assert.equal(Object.hasOwn(config, 'adminHash'), false);
  assert.equal(Object.hasOwn(config, 'adminUsername'), false);
});

class AdminPool {
  constructor() {
    this.sessions = new Map([
      [hashToken(adminToken), { id: adminId, username: '123456789', name: '管理员', grade: null, role: 'admin' }],
      [hashToken(studentToken), { id: studentAId, username: 'student_a', name: 'Student A', grade: 3, role: 'student' }]
    ]);
  }
  async query(sql, values = []) {
    if (sql.includes('FROM auth_sessions JOIN users')) return { rows: this.sessions.has(values[0]) ? [this.sessions.get(values[0])] : [] };
    if (sql.includes("FROM users WHERE username = $1 AND role = 'admin'")) {
      return { rows: values[0] === '123456789' ? [{ id: adminId, username: '123456789', name: '管理员', grade: null, role: 'admin', password_hash: passwordHash }] : [] };
    }
    if (sql.includes('INSERT INTO auth_sessions')) {
      this.sessions.set(values[1], { id: adminId, username: '123456789', name: '管理员', grade: null, role: 'admin' });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM auth_sessions WHERE token_hash')) { this.sessions.delete(values[0]); return { rows: [] }; }
    if (sql.includes("SELECT count(*)::int AS count FROM users WHERE role = 'student'")) return { rows: [{ count: 2 }] };
    if (sql.includes('count(DISTINCT ps.student_id)')) return { rows: [{ total_sessions: 4, today_sessions: 2, today_students: 1, total_duration_seconds: '1800' }] };
    if (sql.includes('ps.student_id, u.name AS student_name') && sql.includes('LIMIT 20')) return { rows: [session] };
    if (sql.includes("SELECT count(*)::int AS total FROM users WHERE role = 'student'")) return { rows: [{ total: 2 }] };
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN LATERAL')) return { rows: students.map(student => ({ ...student, total_sessions: 2, total_duration_seconds: '900', last_practice_at: session.started_at })) };
    if (sql.includes("FROM users WHERE id = $1 AND role = 'student'")) return { rows: students.filter(student => student.id === values[0]) };
    if (sql.includes('sum(turn_count)')) return { rows: [{ total_sessions: 2, total_duration_seconds: '900', total_turn_count: '7', last_practice_at: session.started_at }] };
    if (sql.includes('FROM practice_sessions WHERE student_id = $1') && sql.includes('count(*)::int AS total')) return { rows: [{ total: 2 }] };
    if (sql.includes('FROM practice_sessions WHERE student_id = $1') && sql.includes('LIMIT $2 OFFSET $3')) return { rows: [session] };
    if (sql.includes('FROM practice_sessions ps JOIN users u') && sql.includes('WHERE ps.id = $1')) return { rows: [session] };
    if (sql.includes('FROM practice_turns WHERE session_id = $1 ORDER BY turn_number')) return { rows: turns };
    throw new Error(`Unexpected admin database query: ${sql}`);
  }
}

test('admin pages and learning APIs enforce anonymous/student/admin roles and return database records', async t => {
  const pool = new AdminPool();
  const config = { origin, production: false, trustProxy: false, secret: 's'.repeat(96), apiKey: '', model: 'deepseek-flash', maxRecords: 100, maxBytes: 4 * 1024 * 1024, dailyLimit: 1000 };
  const server = createApp(config, {}, { dbPool: pool }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route, cookie = '') => fetch(base + route, { headers: cookie ? { cookie } : {} });
  const post = (route, body, cookie = '') => fetch(base + route, { method: 'POST', headers: { origin, 'x-requested-with': 'ybtc', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

  for (const route of ['/api/admin/me', '/api/admin/summary', '/api/admin/students', `/api/admin/students/${studentAId}`, `/api/admin/practice/sessions/${practiceId}`]) {
    assert.equal((await get(route)).status, 401, route);
  }
  const anonPage = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(anonPage.status, 302);
  assert.equal(anonPage.headers.get('location'), '/admin/login');
  for (const route of ['/api/admin/me', '/api/admin/summary', '/api/admin/students', `/api/admin/students/${studentAId}`, `/api/admin/practice/sessions/${practiceId}`]) {
    assert.equal((await get(route, `ybtc_student=${studentToken}`)).status, 403, route);
  }
  assert.equal((await get('/admin', `ybtc_student=${studentToken}`)).status, 403);

  for (const headers of [
    { origin: 'https://other.example', 'x-requested-with': 'ybtc' },
    { origin }
  ]) {
    const rejected = await fetch(base + '/api/admin/login', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ username: '123456789', password: 'admin-test-password' })
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }

  assert.equal((await post('/api/admin/login', { username: 'student_a', password: 'admin-test-password' })).status, 401);
  const wrong = await post('/api/admin/login', { username: '123456789', password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  const login = await post('/api/admin/login', { username: '123456789', password: 'admin-test-password' });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^ybtc_admin=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /; Path=\/(?:;|$)/i);
  assert.doesNotMatch(setCookie, /; Domain=/i);
  assert.doesNotMatch(setCookie, /; Secure(?:;|$)/i);
  const cookie = setCookie.split(';')[0];
  assert.equal((await get('/admin', cookie)).status, 200);

  const me = await (await get('/api/admin/me', cookie)).json();
  assert.deepEqual(me, { id: adminId, username: '123456789', name: '管理员' });
  const summaryResponse = await get('/api/admin/summary?student_id=forged', cookie);
  assert.equal(summaryResponse.status, 200);
  assert.match(summaryResponse.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(await summaryResponse.json(), {
    studentCount: 2, todayPracticeUsers: 1, todayPracticeSessions: 2, totalPracticeSessions: 4,
    totalDurationSeconds: 1800,
    recentSessions: [{ id: practiceId, studentId: studentAId, studentName: 'Student A', username: 'student_a', topic: '问候与介绍', grade: 3,
      startedAt: session.started_at.toISOString(), endedAt: session.ended_at.toISOString(), durationSeconds: 788, turnCount: 5, status: 'completed' }]
  });
  const studentList = await (await get('/api/admin/students?limit=1&offset=0', cookie)).json();
  assert.equal(studentList.pagination.total, 2);
  assert.equal(studentList.students[0].username, 'student_a');
  assert.equal(studentList.students[0].totalPracticeSessions, 2);
  const studentDetail = await (await get(`/api/admin/students/${studentAId}`, cookie)).json();
  assert.equal(studentDetail.stats.totalTurnCount, 7);
  assert.equal(studentDetail.sessions[0].id, practiceId);
  assert.equal((await get(`/api/admin/students/${adminId}`, cookie)).status, 404);
  const practice = await (await get(`/api/admin/practice/sessions/${practiceId}`, cookie)).json();
  assert.equal(practice.session.durationSeconds, 788);
  assert.equal(practice.session.turnCount, 5);
  assert.deepEqual(practice.turns.map(turn => turn.turnNumber), [1, 2, 3, 4, 5]);
  assert.equal(practice.turns[0].studentText, 'Test student text 1');
  assert.equal(practice.turns[0].aiReply, 'Test AI reply 1');
  assert.equal(Object.hasOwn(practice.turns[0], 'pronunciationScore'), false);

  assert.equal((await post('/api/admin/logout', {}, cookie)).status, 200);
  assert.equal((await get('/api/admin/summary', cookie)).status, 401);
});
