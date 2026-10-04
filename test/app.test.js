import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { DataStore } from '../src/store.js';
import { hashPassword } from '../src/security.js';
import { csvRows, cell } from '../src/csv.js';
import { loadConfig } from '../src/config.js';
let server, base, folder, store, cookie;
let upstreamMode = 'ok', upstreamBody;
const origin = 'http://localhost:3000';
const studentId = '00000000-0000-4000-8000-000000000001';
const adminId = '00000000-0000-4000-8000-000000000002';
const studentToken = 'a'.repeat(43);
const adminToken = 'c'.repeat(43);
const studentCookie = `ybtc_student=${studentToken}`;
const studentTokenHash = createHash('sha256').update(studentToken).digest('hex');
const adminTokenHash = createHash('sha256').update(adminToken).digest('hex');
const testPasswordHash = hashPassword('correct-password-for-tests');
const testSessions = new Map();
const authSessions = new Map([[studentTokenHash, { id: studentId, username: 'student_test', name: 'Test Student', grade: 3, role: 'student' }]]);
const config = { origin, production: false, trustProxy: false, secret: 'x'.repeat(96), apiKey: 'test-only-key', model: 'deepseek-flash', maxRecords: 100, maxBytes: 4*1024*1024, dailyLimit: 1000 };
const dbPool = { async query(sql, values = []) {
  if (sql.includes('FROM auth_sessions JOIN users')) {
    const user = authSessions.get(values[0]);
    return { rows: user && (!sql.includes("users.role = 'student'") || user.role === 'student') ? [user] : [] };
  }
  if (sql.includes("FROM users WHERE username = $1 AND role = 'admin'")) return { rows: values[0] === 'teacher' ? [{ id: adminId, username: 'teacher', name: '管理员', grade: null, role: 'admin', password_hash: testPasswordHash }] : [] };
  if (sql.includes('INSERT INTO auth_sessions')) { authSessions.set(values[1], { id: adminId, username: 'teacher', name: '管理员', grade: null, role: 'admin' }); return { rows: [] }; }
  if (sql.includes('DELETE FROM auth_sessions WHERE token_hash')) { authSessions.delete(values[0]); return { rows: [] }; }
  if (sql.includes('INSERT INTO practice_sessions')) { testSessions.set(values[0], { id: values[0], studentId: values[1], topic: values[2], grade: values[3] }); return { rows: [] }; }
  if (sql.includes('SELECT id FROM practice_sessions')) {
    const row = testSessions.get(values[0]);
    return { rows: row && row.studentId === values[1] && row.grade === values[2] && row.topic === values[3] ? [{ id: row.id }] : [] };
  }
  throw new Error(`Unexpected test database query: ${sql}`);
} };
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ybtc-test-'));
  store = new DataStore(path.join(folder, 'userData.json'), config); await store.init();
  server = createApp(config, store, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-only-key');
    upstreamBody = JSON.parse(options.body);
    if (upstreamMode === 'timeout') { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
    if (upstreamMode === 'badstatus') return new Response('private upstream error', { status: 401 });
    if (upstreamMode === 'malformed') return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: 'Hello! How are you?', comment: { highlight: '你勇敢地开口了。', suggestion: '试着用完整的句子回答。' } }) } }] });
  }, dbPool }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(folder, { recursive: true, force: true }); });
async function post(route, body, extra = {}) {
  return fetch(base+route, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-requested-with': 'ybtc', cookie: studentCookie, ...extra }, body: JSON.stringify(body) });
}
async function session() {
  const created = await post('/api/practice/sessions', { grade: 3, topic: '问候与介绍', consent: true }); assert.equal(created.status, 201);
  const { sessionId: practiceSessionId } = await created.json();
  const r = await post('/api/startSession', { grade: 3, topic: '问候与介绍', consent: true, practiceSessionId }); assert.equal(r.status, 200); return r.json();
}
async function turn(s, history = [], value = 'Hello!') {
  return post('/api/chat', { sessionToken: s.sessionToken, history, grade: 3, topic: '问候与介绍', text: value, confidence: null, inputMode: 'text' });
}
test('anonymous users cannot access admin data, export, dashboard or private files', async () => {
  for (const route of ['/api/getAllData','/api/exportCsv','/api/adminMe']) assert.equal((await fetch(base+route)).status, 401);
  const page = await fetch(base+'/admin', { redirect: 'manual' }); assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/admin/login');
  for (const route of ['/data/userData.json','/userData.json','/.env','/src/config.js','/admin.html','/%61dmin.html','/views/admin.html']) assert.equal((await fetch(base+route)).status, 404);
});
test('rejects foreign origins, audio requests, malformed bodies and invalid topics', async () => {
  assert.equal((await post('/api/adminLogin', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(base+'/api/saveChat', { method: 'POST', headers: { origin, 'x-requested-with':'ybtc', 'content-type':'audio/wav' }, body: 'audio' })).status, 415);
  assert.equal((await post('/api/startSession', [])).status, 400);
  assert.equal((await post('/api/startSession', { grade: 9, topic: '颜色', consent: true })).status, 400);
  assert.equal((await post('/api/startSession', { grade: 3, topic: '颜色', consent: false })).status, 400);
});
test('official practice records require the server-side student session and ignore client student IDs', async () => {
  assert.equal((await post('/api/practice/sessions', { grade: 3, topic: '问候与介绍', consent: true }, { cookie: '' })).status, 401);
  const created = await post('/api/practice/sessions', { grade: 3, topic: '问候与介绍', consent: true, student_id: 'forged' });
  assert.equal(created.status, 201);
  const { sessionId } = await created.json();
  assert.equal(testSessions.get(sessionId).studentId, studentId);
});
test('a database outage does not block chat replies for an already-started signed session', async t => {
  const s = await session();
  let databaseCalls = 0;
  const unavailablePool = { async query() { databaseCalls++; throw new Error('simulated database outage'); } };
  const outageApp = createApp(config, store, {
    dbPool: unavailablePool,
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: 'I am fine, thank you!', comment: { highlight: '你主动用英语问候了。', suggestion: '试着再介绍一下自己。' } }) } }] })
  });
  const outageServer = outageApp.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => outageServer.close(resolve)));
  await new Promise(resolve => outageServer.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${outageServer.address().port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-requested-with': 'ybtc' },
    body: JSON.stringify({ sessionToken: s.sessionToken, history: [], grade: 3, topic: '问候与介绍', text: 'Hello!', confidence: null, inputMode: 'text' })
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).reply);
  assert.equal(databaseCalls, 0);
});
test('chat uses server-only key, fixed model, signed history and exact teaching prompt', async () => {
  const s = await session(); const response = await turn(s); assert.equal(response.status, 200); const t = await response.json();
  const signedTurn = JSON.parse(Buffer.from(t.receipt.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(signedTurn.studentId, studentId);
  assert.ok(signedTurn.practiceSessionId);
  assert.equal(upstreamBody.model, 'deepseek-flash'); assert.equal(upstreamBody.thinking.type, 'disabled');
  assert.match(upstreamBody.messages[0].content, /禁止超纲词汇/);
  const second = await turn(s, [t.receipt], 'I am fine.'); assert.equal(second.status, 200);
  assert.equal(upstreamBody.messages.length, 5);
  assert.equal((await turn(s, [t.receipt+'x'])).status, 400);
  const other = await session(); assert.equal((await turn(other, [t.receipt])).status, 400);
  const t2 = await second.json(); assert.equal((await turn(s, [t2.receipt])).status, 400);
});
test('parallel saves persist every session; retries are idempotent and cannot overwrite data', async () => {
  const s = await session(); const t = await (await turn(s)).json();
  const responses = await Promise.all(Array.from({ length: 8 }, () => post('/api/saveChat', { sessionToken: s.sessionToken, history: [t.receipt], studentTexts: ['forged'], audio: 'ignored' })));
  assert.equal(responses.filter(r => r.status === 201).length, 1); assert.equal(responses.filter(r => r.status === 200).length, 7);
  const row = (await store.read()).find(r => r.sessionId === s.sessionId); assert.equal(row.studentTexts[0], 'Hello!'); assert.equal(row.audio, undefined); assert.equal(row.recognitionConfidences[0], null);
  const t2 = await (await turn(s, [t.receipt])).json();
  assert.equal((await post('/api/saveChat', { sessionToken: s.sessionToken, history: [t.receipt,t2.receipt] })).status, 409);
  await Promise.all(Array.from({ length: 6 }, async () => { const a = await session(); const b = await (await turn(a)).json(); assert.equal((await post('/api/saveChat', { sessionToken: a.sessionToken, history: [b.receipt] })).status, 201); }));
  assert.equal((await store.read()).length, 7);
  const reopened = new DataStore(store.filename, config); await reopened.init(); assert.equal((await reopened.read()).length, 7);
});
test('administrator login, stats, UTF-8 CSV and logout work', async () => {
  assert.equal((await post('/api/adminLogin', { username:'teacher', password:'wrong' })).status, 401);
  const login = await post('/api/adminLogin', { username:'teacher', password:'correct-password-for-tests' }); assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
  const dataResponse = await fetch(base+'/api/getAllData', { headers: { cookie } }); assert.equal(dataResponse.status, 200); assert.match(dataResponse.headers.get('cache-control'), /no-store/);
  const data = await dataResponse.json(); assert.equal(data.stats.totalSessions, 7); assert.equal(data.stats.topics['3年级 · 问候与介绍'], 7);
  const csv = await fetch(base+'/api/exportCsv', { headers: { cookie } }); assert.equal(csv.status, 200);
  const bytes = new Uint8Array(await csv.arrayBuffer()); assert.deepEqual([...bytes.slice(0,3)], [239,187,191]); assert.match(new TextDecoder().decode(bytes), /表达亮点/);
  assert.equal((await post('/api/adminLogout', {}, { cookie })).status, 200);
  assert.equal((await fetch(base+'/api/getAllData', { headers: { cookie } })).status, 401);
});
test('upstream errors never leak raw responses or invent successful replies', async () => {
  const s = await session();
  for (const mode of ['timeout','badstatus','malformed']) { upstreamMode = mode; const r = await turn(s); assert.equal(r.status, 502); assert.doesNotMatch(await r.text(), /test-only-key|private upstream error/); }
  upstreamMode = 'ok';
});
test('CSV quotes commas, line breaks and neutralizes formula injection', () => {
  assert.equal(cell('a,"b"\nc'), '"a,""b""\nc"'); assert.equal(cell('=1+2'), '"\'=1+2"'); assert.equal(cell(' \t@SUM(A1)'), '"\' \t@SUM(A1)"'); assert.equal(cell(null), '""');
  assert.ok([...csvRows([])][0].startsWith('\uFEFF'));
});
test('corrupt storage is preserved; insecure production settings are rejected', async () => {
  const file = path.join(folder, 'corrupt.json'); await fs.writeFile(file, '{broken'); const bad = new DataStore(file, config); await assert.rejects(() => bad.init()); assert.equal(await fs.readFile(file,'utf8'), '{broken');
  assert.throws(() => loadConfig({ NODE_ENV:'production', ADMIN_USERNAME:'teacher', ADMIN_PASSWORD_HASH:config.adminHash, SESSION_SECRET:config.secret, APP_ORIGIN:'http://example.com' }), /HTTPS/);
});
