import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security.js';

const secret = 's'.repeat(48);
const origin = 'https://practice.example.com';

test('production configuration uses the provider port, public bind address and HTTPS origin', () => {
  const local = loadConfig({ SESSION_SECRET: secret });
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 3101);
  assert.equal(local.origin, 'http://localhost:3101');

  const production = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, PORT: '4789' });
  assert.equal(production.host, '0.0.0.0');
  assert.equal(production.port, 4789);
  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin }).port, 3101);
  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(production.trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, TRUST_PROXY_HOPS: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ SESSION_SECRET: secret, TRUST_PROXY: '1' }).trustProxy, 'loopback');
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, TRUST_PROXY_HOPS: '2' }), /TRUST_PROXY_HOPS/);

  for (const invalid of [undefined, 'http://practice.example.com', 'https://practice.example.com/path', 'https://practice.example.com/?q=1']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: invalid }), /APP_ORIGIN|HTTPS/);
  }
  assert.throws(() => loadConfig({ SESSION_SECRET: secret, APP_ORIGIN: 'ftp://practice.example.com' }), /APP_ORIGIN/);
});

test('root health is minimal and production student/admin cookies remain secure', async t => {
  const password = 'test-only-password';
  const passwordHash = hashPassword(password);
  let databaseQueries = 0;
  const pool = { async query(sql, values = []) {
    databaseQueries++;
    if (sql.includes("FROM users WHERE username = $1 AND role = 'student'")) {
      return { rows: values[0] === 'production_student' ? [{ id: 'student-id', username: values[0], name: 'Student', grade: 3, role: 'student', password_hash: passwordHash }] : [] };
    }
    if (sql.includes("FROM users WHERE username = $1 AND role = 'admin'")) {
      return { rows: values[0] === 'production_admin' ? [{ id: 'admin-id', username: values[0], name: 'Admin', grade: null, role: 'admin', password_hash: passwordHash }] : [] };
    }
    if (sql.includes('INSERT INTO auth_sessions')) return { rows: [] };
    throw new Error(`Unexpected database query: ${sql}`);
  } };
  const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, TRUST_PROXY_HOPS: '1' });
  let legacyWrites = 0;
  const app = createApp(config, { append: async () => { legacyWrites++; } }, { dbPool: pool });
  assert.equal(app.get('trust proxy'), 1);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(databaseQueries, 0);

  const oldArchive = await fetch(base + '/api/saveChat', {
    method: 'POST', headers: { origin, 'x-requested-with': 'ybtc', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken: 'legacy', history: [] })
  });
  assert.equal(oldArchive.status, 410);
  assert.equal(legacyWrites, 0);

  for (const [route, username, sameSite] of [
    ['/api/auth/login', 'production_student', 'Lax'],
    ['/api/admin/login', 'production_admin', 'Lax']
  ]) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { origin, 'x-requested-with': 'ybtc', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(response.status, 200, route);
    const cookie = response.headers.get('set-cookie') || '';
    assert.match(cookie, /; Secure(?:;|$)/i);
    assert.match(cookie, /; HttpOnly(?:;|$)/i);
    assert.match(cookie, new RegExp(`; SameSite=${sameSite}(?:;|$)`, 'i'));
    assert.match(cookie, /; Path=\/(?:;|$)/i);
    assert.doesNotMatch(cookie, /; Domain=/i);
  }
});

test('one trusted Render proxy hop supplies client IP and original HTTPS protocol', async t => {
  const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: secret, APP_ORIGIN: origin, TRUST_PROXY_HOPS: '1' });
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.get('/probe', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/probe`, {
    headers: { 'x-forwarded-for': '198.51.100.77, 203.0.113.25', 'x-forwarded-proto': 'https' }
  });
  assert.deepEqual(await response.json(), { ip: '203.0.113.25', secure: true });
});
