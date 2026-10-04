import path from 'node:path';
export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  function number(name, fallback, min, max) {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} configuration invalid`);
    return value;
  }
  const secret = env.SESSION_SECRET || '';
  if (secret.length < 48) throw new Error('Run npm run setup: SESSION_SECRET is missing/invalid.');
  const configuredOrigin = env.APP_ORIGIN || (production ? '' : 'http://localhost:3101');
  if (!configuredOrigin) throw new Error('Production APP_ORIGIN requires HTTPS');
  let origin;
  try { origin = new URL(configuredOrigin); }
  catch { throw new Error('APP_ORIGIN must be a valid origin'); }
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('APP_ORIGIN must use HTTP or HTTPS');
  if (production && origin.protocol !== 'https:') throw new Error('Production APP_ORIGIN requires HTTPS');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('APP_ORIGIN must be an origin only');
  let trustProxy;
  if (env.TRUST_PROXY_HOPS !== undefined) {
    if (!/^[01]$/.test(env.TRUST_PROXY_HOPS)) throw new Error('TRUST_PROXY_HOPS must be 0 or 1');
    trustProxy = Number(env.TRUST_PROXY_HOPS);
  } else {
    // Retain the localhost Nginx setting for self-managed installs. Render sets
    // TRUST_PROXY_HOPS=1 because its public load balancer is exactly one hop away.
    trustProxy = env.TRUST_PROXY === '1' ? 'loopback' : false;
  }
  const sttProvider = env.STT_PROVIDER || 'disabled';
  if (!['disabled', 'tencent'].includes(sttProvider)) throw new Error('STT_PROVIDER must be disabled or tencent');
  return {
    production, origin: origin.origin, secret,
    apiKey: env.DEEPSEEK_API_KEY || '', model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'), port: number('PORT', 3101, 1, 65535),
    trustProxy,
    dataFile: path.resolve(env.DATA_FILE || './data/userData.json'),
    maxRecords: number('MAX_RECORDS', 20000, 1, 100000),
    maxBytes: number('MAX_DATA_MB', 100, 1, 1024) * 1024 * 1024,
    dailyLimit: number('DAILY_AI_LIMIT', 1000, 1, 1000000),
    stt: {
      provider: sttProvider,
      secretId: env.TENCENT_ASR_SECRET_ID || '',
      secretKey: env.TENCENT_ASR_SECRET_KEY || '',
      ffmpegPath: env.STT_FFMPEG_PATH || 'ffmpeg',
      dailyLimit: number('STT_DAILY_LIMIT', 500, 1, 100000),
      timeoutMs: 30000
    }
  };
}
