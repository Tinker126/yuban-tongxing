import 'dotenv/config';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../src/db.js';

const migrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
let pool, client;
try {
  pool = createDatabasePool();
  client = await pool.connect();
  await client.query('BEGIN');
  // Keep two migration runners from applying the same version concurrently.
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7419001601']);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = (await fs.readdir(migrationsDir)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No SQL migrations were found.');
  const newlyApplied = [];
  for (const filename of files) {
    const version = filename.slice(0, -4);
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(new URL(`../db/migrations/${filename}`, import.meta.url), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    newlyApplied.push(version);
  }
  await client.query('COMMIT');
  console.log(newlyApplied.length ? `PostgreSQL migrations complete: ${newlyApplied.join(', ')}` : 'PostgreSQL migrations already current');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(`PostgreSQL migration failed (${error.code || error.message}).`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
