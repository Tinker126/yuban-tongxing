import 'dotenv/config';
import { loadConfig } from './src/config.js';
import { DataStore } from './src/store.js';
import { createApp } from './src/app.js';
import { createDatabasePool } from './src/db.js';
const config = loadConfig();
// PostgreSQL is the production source of truth. The JSON archive is retained
// only for local/legacy development and is never created or used on Render.
const store = config.production ? null : new DataStore(config.dataFile, config);
if (store) await store.init();
const dbPool = process.env.DATABASE_URL?.trim() ? createDatabasePool() : undefined;
const app = createApp(config, store, { dbPool });
const server = app.listen(config.port, config.host, () => {
  console.log(`语伴童行正在运行：${config.origin}`);
  if (!config.apiKey || config.apiKey.startsWith('replace-')) console.warn('DEEPSEEK_API_KEY尚未配置，AI接口返回503。');
});
server.requestTimeout = 60000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(async () => { await store?.queue; await dbPool?.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 60000).unref();
});
