import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';

const config = loadConfig();
const pool = createDatabasePool();
const suffix = randomBytes(5).toString('hex');
const students = [
  { username: `practicea_${suffix}`, name: '阶段验证A', grade: 3, password: randomBytes(24).toString('base64url') },
  { username: `practiceb_${suffix}`, name: '阶段验证B', grade: 4, password: randomBytes(24).toString('base64url') }
];
const servers = [];
const createdUsers = [];
const cookies = [];

function listen() {
  const server = createApp(config, {}, { dbPool: pool }).listen(0, '127.0.0.1');
  servers.push(server);
  return new Promise(resolve => server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function request(base, route, { method = 'GET', body, cookie } = {}) {
  return fetch(base + route, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'ybtc', Origin: config.origin } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

try {
  const base = await listen();
  for (const student of students) {
    const registration = await request(base, '/api/auth/register', { method: 'POST', body: { ...student, role: 'admin' } });
    assert.equal(registration.status, 201);
    const user = await registration.json();
    createdUsers.push(user.id);
    assert.equal(user.role, 'student');
    const login = await request(base, '/api/auth/login', { method: 'POST', body: student });
    assert.equal(login.status, 200);
    cookies.push((login.headers.get('set-cookie') || '').split(';')[0]);
    assert.ok(cookies.at(-1).startsWith('ybtc_student='));
  }

  assert.equal((await request(base, '/api/practice/sessions', { method: 'POST', body: { grade: 3, topic: '问候与介绍', consent: true } })).status, 401);
  assert.equal((await request(base, '/api/practice/sessions')).status, 401);
  assert.equal((await request(base, '/history')).status, 200);
  assert.equal((await request(base, '/history.js')).status, 200);
  assert.equal((await request(base, '/history.css')).status, 200);
  const create = await request(base, '/api/practice/sessions', {
    method: 'POST', cookie: cookies[0],
    body: { grade: 3, topic: '问候与介绍', consent: true, student_id: createdUsers[1] }
  });
  assert.equal(create.status, 201);
  const { sessionId } = await create.json();
  const row = await pool.query('SELECT student_id, topic, grade, started_at, status, turn_count FROM practice_sessions WHERE id = $1', [sessionId]);
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].student_id, createdUsers[0]);
  assert.equal(row.rows[0].topic, '问候与介绍');
  assert.equal(row.rows[0].grade, 3);
  assert.ok(row.rows[0].started_at);
  assert.equal(row.rows[0].status, 'active');
  assert.equal(row.rows[0].turn_count, 0);

  const secondCreate = await request(base, '/api/practice/sessions', {
    method: 'POST', cookie: cookies[0],
    body: { grade: 3, topic: '动物', consent: true, student_id: createdUsers[1] }
  });
  assert.equal(secondCreate.status, 201);
  const { sessionId: secondSessionId } = await secondCreate.json();
  const bCreate = await request(base, '/api/practice/sessions', {
    method: 'POST', cookie: cookies[1],
    body: { grade: 4, topic: '我的教室', consent: true, student_id: createdUsers[0] }
  });
  assert.equal(bCreate.status, 201);
  const { sessionId: bSessionId } = await bCreate.json();

  const firstPageResponse = await request(base, `/api/practice/sessions?limit=1&student_id=${createdUsers[1]}`, { cookie: cookies[0] });
  assert.equal(firstPageResponse.status, 200);
  assert.match(firstPageResponse.headers.get('cache-control') || '', /no-store/);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.pagination.total, 2);
  assert.equal(firstPage.pagination.hasMore, true);
  const secondPage = await request(base, '/api/practice/sessions?limit=1&offset=1', { cookie: cookies[0] });
  assert.equal(secondPage.status, 200);
  const secondPageData = await secondPage.json();
  assert.equal(secondPageData.sessions.length, 1);
  assert.deepEqual(new Set([firstPage.sessions[0].id, secondPageData.sessions[0].id]), new Set([sessionId, secondSessionId]));
  const aFiltered = await request(base, '/api/practice/sessions?grade=3&topic=%E9%97%AE%E5%80%99%E4%B8%8E%E4%BB%8B%E7%BB%8D&status=active', { cookie: cookies[0] });
  assert.deepEqual((await aFiltered.json()).sessions.map(session => session.id), [sessionId]);
  const bHistory = await request(base, `/api/practice/sessions?student_id=${createdUsers[0]}`, { cookie: cookies[1] });
  assert.deepEqual((await bHistory.json()).sessions.map(session => session.id), [bSessionId]);
  assert.equal((await request(base, `/api/practice/sessions/${bSessionId}`, { cookie: cookies[0] })).status, 404);
  assert.equal((await request(base, `/api/practice/sessions/${sessionId}`, { cookie: cookies[1] })).status, 404);
  assert.equal((await request(base, `/history/${sessionId}`)).status, 200);

  const bind = await request(base, '/api/startSession', {
    method: 'POST', cookie: cookies[0],
    body: { grade: 3, topic: '问候与介绍', consent: true, practiceSessionId: sessionId }
  });
  assert.equal(bind.status, 200);
  const boundChat = await bind.json();
  assert.ok(boundChat.sessionToken);
  assert.equal((await request(base, `/api/practice/sessions/${sessionId}`, { cookie: cookies[0] })).status, 200);
  assert.equal((await request(base, `/api/practice/sessions/${sessionId}`, { cookie: cookies[1] })).status, 404);
  assert.equal((await request(base, '/api/startSession', {
    method: 'POST', cookie: cookies[1],
    body: { grade: 3, topic: '问候与介绍', consent: true, practiceSessionId: sessionId }
  })).status, 404);
  assert.equal((await request(base, `/api/practice/sessions/${sessionId}/turns`, {
    method: 'POST', cookie: cookies[1], body: { turnNumber: 1, receipt: 'not-a-real-receipt' }
  })).status, 404);
  assert.equal((await request(base, `/api/practice/sessions/${sessionId}/complete`, { method: 'PATCH', cookie: cookies[1], body: {} })).status, 404);

  const complete = await request(base, `/api/practice/sessions/${sessionId}/complete`, { method: 'PATCH', cookie: cookies[0], body: {} });
  assert.equal(complete.status, 200);
  const completion = await complete.json();
  assert.equal(completion.status, 'completed');
  const final = await pool.query('SELECT student_id, started_at, ended_at, duration_seconds, turn_count, status FROM practice_sessions WHERE id = $1', [sessionId]);
  assert.equal(final.rows[0].student_id, createdUsers[0]);
  assert.ok(final.rows[0].started_at && final.rows[0].ended_at);
  assert.ok(Number.isInteger(final.rows[0].duration_seconds) && final.rows[0].duration_seconds >= 0);
  assert.equal(final.rows[0].turn_count, 0);
  assert.equal(final.rows[0].status, 'completed');
  const aCompleted = await request(base, '/api/practice/sessions?status=completed&grade=3&topic=%E9%97%AE%E5%80%99%E4%B8%8E%E4%BB%8B%E7%BB%8D', { cookie: cookies[0] });
  assert.deepEqual((await aCompleted.json()).sessions.map(session => session.id), [sessionId]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM practice_turns WHERE session_id = $1', [sessionId])).rows[0].count, 0);

  console.log('Authenticated practice creation, filtered/paginated owner-only history, foreign-student 404, detail access control, turn access control, and server-timed completion: OK');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  for (const userId of createdUsers) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await pool.end();
}
