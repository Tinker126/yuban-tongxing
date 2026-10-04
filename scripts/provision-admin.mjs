import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../src/db.js';

const USERNAME = process.env.ADMIN_USERNAME?.trim() || '123456789';
const LEGACY_USERNAME = '123456789';
const NAME = '管理员';
const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim() || '';
if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/.test(passwordHash)) {
  console.error('ADMIN_PASSWORD_HASH 缺失或格式不正确。请在本地 .env 配置已有密码对应的 scrypt 哈希；不要提供或写入明文密码。');
  process.exit(1);
}

let pool;
try {
  pool = createDatabasePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7419001602']);
    const existing = await client.query('SELECT id, role FROM users WHERE username = $1 FOR UPDATE', [USERNAME]);
    if (existing.rows[0] && existing.rows[0].role !== 'admin') {
      throw new Error('指定管理员账号已被普通学生占用。为避免改变其身份或学习数据，未修改该账号。');
    }
    const legacy = existing.rows[0] ? null : await client.query(
      "SELECT id, role FROM users WHERE username = $1 AND role = 'admin' FOR UPDATE",
      [LEGACY_USERNAME]
    );
    const account = existing.rows[0] || legacy?.rows[0];
    if (account) {
      await client.query(
        `UPDATE users SET username = $2, name = $3, password_hash = $4, grade = NULL, updated_at = now()
         WHERE id = $1 AND role = 'admin'`,
        [account.id, USERNAME, NAME, passwordHash]
      );
    } else {
      await client.query(
        `INSERT INTO users (id, username, name, password_hash, grade, role)
         VALUES ($1, $2, $3, $4, NULL, 'admin')`,
        [randomUUID(), USERNAME, NAME, passwordHash]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  console.log(`管理员账号已在 PostgreSQL 中创建或更新：username=${USERNAME}，name=管理员，role=admin。已使用配置的 scrypt 哈希；没有读取或输出明文密码。`);
} catch (error) {
  console.error(`管理员账号配置失败：${error.message}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
