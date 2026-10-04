import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';

const config = loadConfig();
const pool = createDatabasePool();
const username = `authcheck_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
let userId;
const servers = [];

async function listen(testConfig) {
  const server = createApp(testConfig, {}, { dbPool: pool }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, origin, route, body, cookie) {
  return fetch(base + route, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ybtc',
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

try {
  const base = await listen(config);
  const unauthed = await fetch(base + '/api/auth/me');
  assert.equal(unauthed.status, 401);
  assert.equal((await unauthed.json()).error, '未登录。');
  assert.equal((await post(base, config.origin, '/api/auth/register', { username, name: '测试学生', password, grade: 9 })).status, 400);

  const registration = await post(base, config.origin, '/api/auth/register', {
    username, name: '测试学生', password, grade: 4, role: 'admin', password_hash: 'forged'
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  userId = registered.id;
  assert.deepEqual(Object.keys(registered).sort(), ['grade', 'id', 'name', 'role', 'username']);
  assert.equal(registered.role, 'student');
  const users = await pool.query('SELECT id, username, name, password_hash, grade, role FROM users WHERE id = $1', [userId]);
  assert.equal(users.rowCount, 1);
  assert.equal(users.rows[0].username, username);
  assert.equal(users.rows[0].grade, 4);
  assert.equal(users.rows[0].role, 'student');
  assert.notEqual(users.rows[0].password_hash, password);
  assert.match(users.rows[0].password_hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal((await post(base, config.origin, '/api/auth/register', { username, name: '重复', password, grade: 4 })).status, 409);
  assert.equal((await post(base, 'https://foreign.example', '/api/auth/register', { username: 'foreign', name: '拒绝', password, grade: 4 })).status, 403);
  console.log('Registration, users row, password hash, unique username, role=student: OK');

  const wrong = await post(base, config.origin, '/api/auth/login', { username, password: 'wrong-password' });
  const unknown = await post(base, config.origin, '/api/auth/login', { username: `missing_${randomBytes(4).toString('hex')}`, password });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  const login = await post(base, config.origin, '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), registered);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^ybtc_student=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Secure(?:;|$)/i);
  const cookie = setCookie.split(';')[0];
  const token = cookie.split('=')[1];
  const sessions = await pool.query('SELECT token_hash, user_id, expires_at > now() AS active FROM auth_sessions WHERE user_id = $1', [userId]);
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].active, true);
  assert.equal(sessions.rows[0].token_hash.length, 64);
  assert.notEqual(sessions.rows[0].token_hash, token);
  assert.equal(sessions.rows[0].token_hash, createHash('sha256').update(token).digest('hex'));

  const current = await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(current.status, 200);
  assert.match(current.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(await current.json(), registered);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/register')).status, 200);
  assert.equal((await fetch(base + '/login')).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  const secondBase = await listen(config);
  assert.equal((await fetch(secondBase + '/api/auth/me', { headers: { Cookie: cookie } })).status, 200);
  console.log('Login, auth_sessions row, HttpOnly cookie, repeated /me across app instances: OK');

  const production = { ...config, production: true, origin: 'https://auth-test.example' };
  const productionBase = await listen(production);
  const productionLogin = await post(productionBase, production.origin, '/api/auth/login', { username, password });
  assert.equal(productionLogin.status, 200);
  const productionCookie = productionLogin.headers.get('set-cookie') || '';
  assert.match(productionCookie, /; Secure(?:;|$)/i);
  assert.match(productionCookie, /HttpOnly/i);
  assert.match(productionCookie, /SameSite=Lax/i);
  assert.equal((await post(productionBase, production.origin, '/api/auth/logout', {}, productionCookie.split(';')[0])).status, 200);
  console.log('Production Secure cookie: OK');

  const logout = await post(base, config.origin, '/api/auth/logout', {}, cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Expires=/i);
  assert.equal((await pool.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [userId])).rowCount, 0);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(secondBase + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  console.log('Logout, DB session revocation, /me rejection: OK');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
}
