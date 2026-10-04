import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSpeechRouter, readAudio } from '../src/speech-router.js';
import { audioFormat, MAX_AUDIO_BYTES, transcodeAudio, ffmpegAvailable } from '../src/stt/audio.js';
import { createTencentProvider, signedHeaders } from '../src/stt/tencent.js';
import { SttError } from '../src/stt/errors.js';

const cookie = `ybtc_student=${'s'.repeat(43)}`;
const tokenHash = createHash('sha256').update('s'.repeat(43)).digest('hex');
const pool = { async query(sql, values) { return { rows: values[0] === tokenHash ? [{ id: 'student-a', role: 'student' }] : [] }; } };
const webm = () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const pcm = () => Buffer.alloc(32000, 1);
const stt = { provider: 'tencent', dailyLimit: 500, timeoutMs: 30000 };

async function setup(t, options = {}, settings = stt) {
  const app = express();
  app.use('/api/speech', createSpeechRouter(pool, { stt: settings }, {
    readiness: async () => true,
    transcoder: async () => ({ audio: pcm(), durationSeconds: 1 }),
    provider: { async transcribeAudio() { return { text: 'test fixture', provider: 'tencent' }; } },
    ...options
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/speech`;
  return {
    get: () => fetch(`${base}/capabilities`),
    post: (body = webm(), headers = {}) => fetch(`${base}/transcribe`, {
      method: 'POST', headers: { cookie, 'Content-Type': 'audio/webm', ...headers }, body
    })
  };
}

test('server STT authenticates before accepting audio and capabilities expose no secrets', async t => {
  const api = await setup(t);
  const info = await (await api.get()).json();
  assert.equal(info.serverStt.available, true);
  assert.equal(info.serverStt.maxDurationSeconds, 25);
  assert.equal(info.serverStt.maxBytes, MAX_AUDIO_BYTES);
  assert.deepEqual(Object.keys(info.serverStt).sort(), ['available', 'maxBytes', 'maxDurationSeconds', 'mimeTypes', 'provider']);
  assert.equal((await api.post(webm(), { cookie: '' })).status, 401);
  assert.equal((await api.post(webm(), { cookie: `ybtc_student=${'x'.repeat(43)}` })).status, 401);
});

test('server STT returns provider text and destroys compressed and normalized audio after success', async t => {
  let input, normalized, providerCalls = 0;
  const api = await setup(t, {
    transcoder: async ({ audio }) => { input = audio; normalized = pcm(); return { audio: normalized, durationSeconds: 1 }; },
    provider: { async transcribeAudio({ audio, mimeType, language }) {
      providerCalls++;
      assert.equal(audio, normalized);
      assert.equal(mimeType, 'audio/pcm');
      assert.equal(language, 'en');
      return { text: '  fixture result  ' };
    } }
  });
  const response = await api.post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'fixture result', provider: 'tencent', confidence: null });
  assert.equal(providerCalls, 1);
  assert.ok(input.every(byte => byte === 0));
  assert.ok(normalized.every(byte => byte === 0));
});

test('server STT rejects malformed, empty, oversized, unsupported and overlong input without provider calls', async t => {
  let providerCalls = 0, tooLong;
  const api = await setup(t, {
    transcoder: async () => { tooLong = Buffer.alloc(26 * 32000, 1); return { audio: tooLong, durationSeconds: 26 }; },
    provider: { async transcribeAudio() { providerCalls++; } }
  });
  assert.equal((await api.post(Buffer.alloc(0))).status, 400);
  assert.equal((await api.post(Buffer.from('not audio'))).status, 400);
  assert.equal((await api.post(webm(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api.post(webm(), { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await api.post(Buffer.alloc(MAX_AUDIO_BYTES + 1))).status, 413);
  const overlong = await api.post();
  assert.equal(overlong.status, 413);
  assert.equal((await overlong.json()).code, 'STT_AUDIO_TOO_LONG');
  assert.ok(tooLong.every(byte => byte === 0));
  assert.equal(providerCalls, 0);
});

test('provider errors expose fixed messages, zero audio and allow the next attempt', async t => {
  const buffers = [];
  let fail = true;
  const api = await setup(t, {
    transcoder: async ({ audio }) => { const decoded = pcm(); buffers.push(audio, decoded); return { audio: decoded, durationSeconds: 1 }; },
    provider: { async transcribeAudio() { if (fail) throw new Error('must-not-leak'); return { text: 'retry fixture' }; } }
  });
  const failed = await api.post();
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /must-not-leak/);
  assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
  fail = false;
  assert.equal((await api.post()).status, 200);
});

test('unavailable configuration, no speech, daily quota and per-student request limit are explicit', async t => {
  const unavailable = await setup(t, { readiness: async () => false });
  assert.equal((await (await unavailable.get()).json()).serverStt.available, false);
  assert.equal((await unavailable.post()).status, 503);
  const silent = await setup(t, { provider: { async transcribeAudio() { return { text: '' }; } } });
  assert.equal((await (await silent.post()).json()).code, 'STT_NO_SPEECH');
  const daily = await setup(t, {}, { ...stt, dailyLimit: 1 });
  assert.equal((await daily.post()).status, 200);
  assert.equal((await daily.post()).status, 429);
  const limited = await setup(t);
  for (let i = 0; i < 12; i++) assert.equal((await limited.post()).status, 200);
  assert.equal((await limited.post()).status, 429);
});

test('timeout aborts provider, releases student slot and zeros audio', async t => {
  let decoded, calls = 0;
  const api = await setup(t, {
    transcoder: async () => { decoded = pcm(); return { audio: decoded, durationSeconds: 1 }; },
    provider: { async transcribeAudio({ signal }) {
      calls++;
      if (calls > 1) return { text: 'retry fixture' };
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new SttError('STT_ABORTED', 499)), { once: true }));
    } }
  }, { ...stt, timeoutMs: 30 });
  const response = await api.post();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'STT_TIMEOUT');
  assert.ok(decoded.every(byte => byte === 0));
  assert.equal((await api.post()).status, 200);
});

test('a second concurrent request from the same student is refused before decoding', async t => {
  let started, release;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const api = await setup(t, {
    provider: { async transcribeAudio() {
      started();
      await new Promise(resolve => { release = resolve; });
      return { text: 'fixture result' };
    } }
  });
  const first = api.post();
  await providerStarted;
  const second = await api.post();
  assert.equal(second.status, 503);
  assert.equal((await second.json()).code, 'STT_BUSY');
  release();
  assert.equal((await first).status, 200);
});

test('raw upload reader clears partial buffers on cancellation and streaming size overflow', async () => {
  const stream = new PassThrough(), controller = new AbortController();
  const partial = Buffer.from('private audio');
  const reading = readAudio(stream, controller.signal);
  stream.write(partial);
  controller.abort();
  await assert.rejects(reading, { code: 'STT_ABORTED' });
  assert.ok(partial.every(byte => byte === 0));
  const largeStream = new PassThrough();
  const oversized = Buffer.alloc(MAX_AUDIO_BYTES + 1, 1);
  const largeRead = readAudio(largeStream);
  largeStream.end(oversized);
  await assert.rejects(largeRead, { code: 'STT_AUDIO_TOO_LARGE' });
  assert.ok(oversized.every(byte => byte === 0));
});

test('audio magic must match declared MIME; FFmpeg uses only pipes and rejects actual excessive PCM duration', async () => {
  assert.equal(audioFormat(webm(), 'audio/webm;codecs=opus'), 'matroska');
  assert.throws(() => audioFormat(webm(), 'audio/ogg'), { code: 'STT_INVALID_AUDIO' });
  const output = Buffer.alloc(26 * 32000, 1);
  let argumentsUsed;
  const spawnImpl = (command, args, options) => {
    argumentsUsed = args;
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => child.emit('close', -1);
    child.stdin.on('finish', () => { child.stdout.write(output); child.emit('close', 0); });
    return child;
  };
  await assert.rejects(transcodeAudio({ audio: webm(), mimeType: 'audio/webm', spawnImpl }), { code: 'STT_AUDIO_TOO_LONG' });
  assert.ok(output.every(byte => byte === 0));
  assert.equal(argumentsUsed[argumentsUsed.indexOf('-protocol_whitelist') + 1], 'pipe');
  assert.equal(argumentsUsed[argumentsUsed.indexOf('-i') + 1], 'pipe:0');
  assert.equal(argumentsUsed.at(-1), 'pipe:1');
  assert.equal(await ffmpegAvailable('unavailable', () => { throw new Error('missing'); }), false);
});

test('Tencent adapter sends PCM to fixed HTTPS endpoint, English model and signed request without returning metadata', async () => {
  const config = { secretId: 'unit-test-id', secretKey: 'unit-test-secret' };
  const audio = pcm();
  const provider = createTencentProvider(config, { fetchImpl: async (url, init) => {
    assert.equal(url, 'https://asr.tencentcloudapi.com/');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.EngSerViceType, '16k_en');
    assert.equal(body.SourceType, 1);
    assert.equal(body.VoiceFormat, 'pcm');
    assert.equal(body.DataLen, audio.length);
    assert.ok(Buffer.from(body.Data, 'base64').equals(audio));
    assert.match(init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=unit-test-id\/\d{4}-\d{2}-\d{2}\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/);
    return new Response(JSON.stringify({ Response: { Result: 'provider fixture', RequestId: 'excluded' } }));
  } });
  assert.deepEqual(await provider.transcribeAudio({ audio, mimeType: 'audio/pcm', language: 'en' }),
    { text: 'provider fixture', provider: 'tencent', confidence: null });
  assert.equal(signedHeaders('{}', config, 1551113065)['X-TC-Timestamp'], '1551113065');
  const diagnosticCodes = [];
  const failed = createTencentProvider(config, { onProviderError: code => diagnosticCodes.push(code), fetchImpl: async () => new Response(JSON.stringify({ Response: { Error: { Code: 'AuthFailure', Message: 'private provider detail' } } })) });
  await assert.rejects(failed.transcribeAudio({ audio, mimeType: 'audio/pcm', language: 'en' }), error => error.code === 'STT_PROVIDER_AUTH' && !error.message.includes('private'));
  assert.deepEqual(diagnosticCodes, ['AuthFailure']);
});

test('Tencent configuration, activation and quota errors are distinct and diagnostic codes are sanitized', async () => {
  const logged = [];
  for (const [providerCode, publicCode] of [
    ['FailedOperation.UserNotRegistered', 'STT_PROVIDER_NOT_ACTIVATED'],
    ['FailedOperation.UserHasNoAmount', 'STT_PROVIDER_QUOTA'],
    ['UnauthorizedOperation', 'STT_PROVIDER_AUTH'],
    ['RequestLimitExceeded', 'STT_BUSY'],
    ['invalid\nprivate detail', 'STT_PROVIDER_ERROR']
  ]) {
    const provider = createTencentProvider({ secretId: 'unit-test-id', secretKey: 'unit-test-secret' }, {
      onProviderError: code => logged.push(code),
      fetchImpl: async () => Response.json({ Response: { Error: { Code: providerCode, Message: 'never-log' } } })
    });
    await assert.rejects(provider.transcribeAudio({ audio: pcm(), mimeType: 'audio/pcm', language: 'en' }), { code: publicCode });
  }
  assert.deepEqual(logged, ['FailedOperation.UserNotRegistered', 'FailedOperation.UserHasNoAmount', 'UnauthorizedOperation', 'RequestLimitExceeded', 'Unknown']);
});
