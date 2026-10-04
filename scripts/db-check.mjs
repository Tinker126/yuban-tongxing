import 'dotenv/config';
import { checkDatabase, createDatabasePool } from '../src/db.js';

let pool;
try {
  pool = createDatabasePool();
  await checkDatabase(pool);
  console.log('PostgreSQL connection OK');
} catch (error) {
  console.error(`PostgreSQL connection unavailable (${error.code || error.message}).`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
