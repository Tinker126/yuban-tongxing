import { createHash, createHmac } from 'node:crypto';
import { SttError } from './errors.js';

const HOST = 'asr.tencentcloudapi.com';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);

// TC3 algorithm: https://cloud.tencent.com/document/product/1278/46714
export function signedHeaders(body, { secretId, secretKey }, timestamp = Math.floor(Date.now() / 1000)) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/asr/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:${CONTENT_TYPE}\nhost:${HOST}\n\ncontent-type;host\n${hash(body)}`;
  const signingText = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const dateKey = hmac(`TC3${secretKey}`, date);
  const serviceKey = hmac(dateKey, 'asr');
  const signingKey = hmac(serviceKey, 'tc3_request');
  const signature = hmac(signingKey, signingText, 'hex');
  dateKey.fill(0); serviceKey.fill(0); signingKey.fill(0);
  return {
    'Content-Type': CONTENT_TYPE, Host: HOST,
    'X-TC-Action': 'SentenceRecognition', 'X-TC-Version': '2019-06-14', 'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`
  };
}

// SentenceRecognition: https://cloud.tencent.com/document/api/1093/35646
export function createTencentProvider(config, { fetchImpl = fetch, onProviderError = code => console.warn('[STT provider code]', code) } = {}) {
  return {
    async transcribeAudio({ audio, mimeType, language, signal }) {
      if (!config.secretId || !config.secretKey) throw new SttError('STT_UNAVAILABLE', 503);
      if (language !== 'en' || mimeType !== 'audio/pcm') throw new SttError('STT_UNSUPPORTED_AUDIO', 415);
      if (!Buffer.isBuffer(audio) || !audio.length) throw new SttError('STT_EMPTY_AUDIO', 400);
      // JSON/base64 are temporary request strings; they are never logged, persisted, or retained by this module.
      let body = JSON.stringify({ EngSerViceType: '16k_en', SourceType: 1, VoiceFormat: 'pcm',
        Data: audio.toString('base64'), DataLen: audio.length, WordInfo: 0 });
      try {
        const response = await fetchImpl(`https://${HOST}/`, {
          method: 'POST', headers: signedHeaders(body, config), body, signal, redirect: 'error'
        });
        if (!response.ok) { await response.body?.cancel(); throw new SttError('STT_PROVIDER_ERROR'); }
        const data = await response.json();
        if (data.Response?.Error) {
          // Never pass Error.Message, the response, request, audio, or credentials to logging.
          const supplied = data.Response.Error.Code;
          const code = typeof supplied === 'string' && supplied.length <= 100 && /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/.test(supplied) ? supplied : 'Unknown';
          try { onProviderError(code); } catch { /* Diagnostics must not alter response safety. */ }
          if (code === 'FailedOperation.UserNotRegistered') throw new SttError('STT_PROVIDER_NOT_ACTIVATED', 503);
          if (/^(AuthFailure|UnauthorizedOperation)(\.|$)/.test(code)) throw new SttError('STT_PROVIDER_AUTH', 503);
          if (['FailedOperation.ServiceIsolate', 'FailedOperation.UserHasNoAmount', 'FailedOperation.UserHasNoFreeAmount'].includes(code)) throw new SttError('STT_PROVIDER_QUOTA', 503);
          if (/^(RequestLimitExceeded|LimitExceeded)(\.|$)/.test(code)) throw new SttError('STT_BUSY', 429);
          throw new SttError('STT_PROVIDER_ERROR');
        }
        const text = data.Response?.Result;
        if (typeof text !== 'string') throw new SttError('STT_PROVIDER_ERROR');
        if (!text.trim()) throw new SttError('STT_NO_SPEECH', 422);
        if (text.trim().length > 600) throw new SttError('STT_AUDIO_TOO_LONG', 413);
        return { text: text.trim(), provider: 'tencent', confidence: null };
      } catch (error) {
        if (signal?.aborted) throw new SttError('STT_ABORTED', 499);
        if (error instanceof SttError) throw error;
        throw new SttError('STT_PROVIDER_ERROR');
      } finally { body = ''; }
    }
  };
}
