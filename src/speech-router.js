import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { findStudentSession } from './student-session.js';
import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, MIME_TYPES, audioFormat, ffmpegAvailable, transcodeAudio } from './stt/audio.js';
import { createTencentProvider } from './stt/tencent.js';
import { SttError, publicSttError } from './stt/errors.js';

// A bounded raw upload reader makes cleanup explicit, including partial/aborted uploads.
export function readAudio(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', failed);
      req.removeListener('aborted', aborted);
      signal?.removeEventListener('abort', aborted);
      const result = error ? null : Buffer.concat(chunks, bytes);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (error) {
        // An aborted IncomingMessage can emit error after aborted; keep draining harmlessly.
        req.once('error', () => {});
        req.resume(); reject(error);
      }
      else resolve(result);
    };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_AUDIO_BYTES) { chunk.fill(0); finish(new SttError('STT_AUDIO_TOO_LARGE', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => finish(bytes ? null : new SttError('STT_EMPTY_AUDIO', 400));
    const failed = () => finish(new SttError('STT_INVALID_AUDIO', 400));
    const aborted = () => finish(new SttError('STT_ABORTED', 499));
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', aborted);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function createSpeechRouter(pool, config, options = {}) {
  const router = Router();
  const settings = config.stt || { provider: 'disabled' };
  const provider = options.provider || createTencentProvider(settings);
  const transcoder = options.transcoder || transcodeAudio;
  let readinessPromise;
  const ready = options.readiness || (() => {
    if (settings.provider !== 'tencent' || !settings.secretId || !settings.secretKey) return Promise.resolve(false);
    return readinessPromise ||= ffmpegAvailable(settings.ffmpegPath || 'ffmpeg');
  });
  let day = '', requestsToday = 0;
  const activeStudents = new Set();
  const requestLimit = rateLimit({
    windowMs: 60000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: req => req.student.id,
    message: { error: '语音识别请求太频繁，请稍后再试。', code: 'STT_RATE_LIMITED' }
  });

  router.get('/capabilities', async (req, res) => {
    let available = false;
    try { available = Boolean(await ready()); } catch { /* Capability checks expose no process details. */ }
    res.set('Cache-Control', 'no-store').json({ serverStt: {
      available, provider: settings.provider === 'tencent' ? 'tencent' : 'disabled',
      maxBytes: MAX_AUDIO_BYTES, maxDurationSeconds: MAX_AUDIO_SECONDS, mimeTypes: MIME_TYPES
    } });
  });

  router.post('/transcribe', async (req, res, next) => {
    try {
      const student = await findStudentSession(req, pool);
      if (!student) throw new SttError('STT_UNAUTHENTICATED', 401);
      req.student = student;
      next();
    } catch (error) {
      const safe = error instanceof SttError ? error : new SttError('STT_UNAVAILABLE', 503);
      res.status(safe.status).json({ error: safe.message, code: safe.code });
    }
  }, requestLimit, async (req, res) => {
    let audio, pcm, timer, timeout = false, reserved = false;
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try {
      if (!await ready()) throw new SttError('STT_UNAVAILABLE', 503);
      const mimeType = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!MIME_TYPES.includes(mimeType) || (req.get('content-encoding') && req.get('content-encoding') !== 'identity')) {
        throw new SttError('STT_UNSUPPORTED_AUDIO', 415);
      }
      const declaredLength = req.get('content-length');
      if (declaredLength && Number(declaredLength) > MAX_AUDIO_BYTES) throw new SttError('STT_AUDIO_TOO_LARGE', 413);
      if (activeStudents.size >= 3 || activeStudents.has(req.student.id)) throw new SttError('STT_BUSY', 503);
      const today = new Date().toISOString().slice(0, 10);
      if (day !== today) { day = today; requestsToday = 0; }
      if (requestsToday >= (settings.dailyLimit || 500)) throw new SttError('STT_DAILY_LIMIT', 429);
      activeStudents.add(req.student.id);
      reserved = true;
      timer = setTimeout(() => { timeout = true; controller.abort(); }, settings.timeoutMs || 30000);
      audio = await readAudio(req, controller.signal);
      audioFormat(audio, mimeType);
      const normalized = await transcoder({ audio, mimeType, signal: controller.signal, ffmpegPath: settings.ffmpegPath || 'ffmpeg' });
      pcm = normalized.audio;
      if (!Buffer.isBuffer(pcm) || !pcm.length) throw new SttError('STT_EMPTY_AUDIO', 400);
      if (pcm.length > MAX_AUDIO_SECONDS * 32000 || normalized.durationSeconds > MAX_AUDIO_SECONDS) throw new SttError('STT_AUDIO_TOO_LONG', 413);
      if (controller.signal.aborted) throw new SttError('STT_ABORTED', 499);
      // Concurrent conversions may have consumed the remaining quota since admission.
      if (requestsToday >= (settings.dailyLimit || 500)) throw new SttError('STT_DAILY_LIMIT', 429);
      requestsToday++;
      const result = await provider.transcribeAudio({ audio: pcm, mimeType: 'audio/pcm', language: 'en', signal: controller.signal });
      if (controller.signal.aborted) throw new SttError('STT_ABORTED', 499);
      if (typeof result.text !== 'string' || !result.text.trim()) throw new SttError('STT_NO_SPEECH', 422);
      if (result.text.trim().length > 600) throw new SttError('STT_AUDIO_TOO_LONG', 413);
      res.set('Cache-Control', 'no-store').json({ text: result.text.trim(), provider: 'tencent', confidence: null });
    } catch (error) {
      const safe = timeout ? new SttError('STT_TIMEOUT', 504) : publicSttError(error);
      if (!res.destroyed) res.status(safe.status).json({ error: safe.message, code: safe.code });
    } finally {
      clearTimeout(timer);
      res.removeListener('close', disconnect);
      if (reserved) activeStudents.delete(req.student.id);
      // No filesystem, object storage, database audio column, or request payload logging.
      audio?.fill(0);
      pcm?.fill(0);
    }
  });
  return router;
}
