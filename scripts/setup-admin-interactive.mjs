import 'dotenv/config';
import fs from 'node:fs/promises';
import { hashPassword } from '../src/security.js';
import { createDatabasePool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

function readPrompt(prompt, { hidden = false } = {}) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run npm run admin:setup from an interactive SSH terminal.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return done(new Error('Setup cancelled.'));
        if (char === '\r' || char === '\n') return done(null, value);
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          if (!hidden) process.stdout.write('\b \b');
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          value += char;
          if (!hidden) process.stdout.write(char);
        }
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function replaceEnvValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const indexes = lines.flatMap((line, index) => new RegExp(`^\\s*${key}\\s*=`).test(line) ? [index] : []);
  if (indexes.length > 1) throw new Error(`Multiple ${key} entries in .env; no changes applied.`);
  const next = `${key}=${value}`;
  if (indexes.length) lines[indexes[0]] = next;
  else lines.push(next);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

let pool;
let client;
let previousEnv;
let envChanged = false;
let databaseCommitted = false;
try {
  const username = (await readPrompt('请输入新管理员账号：')).trim();
  const password = await readPrompt('请输入新管理员密码：', { hidden: true });
  const confirmation = await readPrompt('请再次输入新管理员密码：', { hidden: true });
  if (!/^[A-Za-z0-9_.-]{6,64}$/.test(username)) {
    throw new Error('Username must be 6–64 letters, numbers, dot, underscore or hyphen.');
  }
  if (password !== confirmation) throw new Error('The two passwords do not match.');
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 256) {
    throw new Error('Password must be 12–128 characters and at most 256 UTF-8 bytes.');
  }

  const passwordHash = hashPassword(password);
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_PASSWORD_HASH = passwordHash;
  const originalEnv = await fs.readFile('.env', 'utf8');
  previousEnv = originalEnv;
  const nextEnv = replaceEnvValue(replaceEnvValue(originalEnv, 'ADMIN_USERNAME', username), 'ADMIN_PASSWORD_HASH', passwordHash);

  pool = createDatabasePool();
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7419001602']);
  const targetResult = await client.query('SELECT id, username, role FROM users WHERE username=$1 FOR UPDATE', [username]);
  const target = targetResult.rows[0];
  if (target && target.role !== 'admin') throw new Error('That username is already used by a student; no changes applied.');
  const admins = await client.query("SELECT id, username, role FROM users WHERE role='admin' FOR UPDATE");
  const configuredUsername = process.env.ADMIN_USERNAME?.trim();
  const configuredAdmin = admins.rows.find(row => row.username === configuredUsername);
  const legacyAdmin = admins.rows.find(row => row.username === '123456789');
  let account = target || configuredAdmin || legacyAdmin || (admins.rows.length === 1 ? admins.rows[0] : null);
  if (!account && admins.rows.length > 1) {
    throw new Error('Multiple administrator accounts exist and none matches the configured account; no changes applied.');
  }

  envChanged = true;
  await fs.writeFile('.env', nextEnv, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod('.env', 0o600);

  let adminId;
  if (account) {
    adminId = account.id;
    await client.query(
      `UPDATE users SET username=$2, name='管理员', password_hash=$3, grade=NULL, updated_at=now()
       WHERE id=$1 AND role='admin'`,
      [adminId, username, passwordHash]
    );
  } else {
    const inserted = await client.query(
      `INSERT INTO users (id, username, name, password_hash, grade, role)
       VALUES (gen_random_uuid()::text, $1, '管理员', $2, NULL, 'admin') RETURNING id`,
      [username, passwordHash]
    );
    adminId = inserted.rows[0].id;
  }
  await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [adminId]);
  await client.query('COMMIT');
  databaseCommitted = true;
  await client.release();
  client = null;

  const config = loadConfig();
  const base = 'http://127.0.0.1:3101';
  const page = await fetch(`${base}/admin/login`, { redirect: 'manual' });
  if (page.status !== 200) throw new Error(`Admin login page check failed (HTTP ${page.status}).`);
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ybtc',
      Origin: config.origin
    },
    body: JSON.stringify({ username, password })
  });
  if (login.status !== 200) throw new Error(`Admin login verification failed (HTTP ${login.status}).`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Admin login did not issue a session cookie.');
  const [meResponse, dashboardResponse] = await Promise.all([
    fetch(`${base}/api/admin/me`, { headers: { cookie } }),
    fetch(`${base}/api/admin/summary`, { headers: { cookie } })
  ]);
  if (meResponse.status !== 200 || dashboardResponse.status !== 200) {
    throw new Error(`Admin authorization verification failed (me=${meResponse.status}, dashboard=${dashboardResponse.status}).`);
  }
  const me = await meResponse.json();
  if (me.username !== username) throw new Error('Authenticated admin identity did not match the configured username.');
  console.log('管理员账号已写入 Neon；密码只保存为 scrypt 哈希。/admin/login、管理员身份和后台权限均验证通过。');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  if (envChanged && !databaseCommitted && previousEnv !== undefined) {
    await fs.writeFile('.env', previousEnv, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
    await fs.chmod('.env', 0o600).catch(() => {});
  }
  console.error(`管理员账号设置未完成：${error.message}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
