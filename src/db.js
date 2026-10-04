import { Pool } from 'pg';

export function loadDatabaseConfig(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is not configured.');

  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host and database.');
  }

  return {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  };
}

export function createDatabasePool(env = process.env) {
  return new Pool(loadDatabaseConfig(env));
}

export async function checkDatabase(pool) {
  const result = await pool.query('SELECT 1 AS ok');
  if (result.rows[0]?.ok !== 1) throw new Error('PostgreSQL health check returned an unexpected result.');
}
