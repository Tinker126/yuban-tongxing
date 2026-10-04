import test from 'node:test';
import assert from 'node:assert/strict';
import { ReliableSpeech } from '../public/reliable-speech.js';
import { MemoryAudioRecorder, selectRecordingMimeType } from '../public/audio-recorder.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function fixture({ userAgent = 'Desktop Chrome', available = true, recognition = true, media = true, fetchUpload, gum } = {}) {
  const tracks = [], streams = [], recorders = [], recognizers = [], requests = [], errors = [], states = [], hints = [], transcripts = [];
  const stream = () => {
    const track = { readyState: 'live', enabled: true, stops: 0, stop() { this.stops++; this.readyState = 'ended'; } };
    tracks.push(track);
    const value = { getTracks: () => [track], getAudioTracks: () => [track] }; streams.push(value); return value;
  };
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(input, options) { this.stream = input; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; this.starts = 0; this.stops = 0; this.payload = 'test encoded audio'; recorders.push(this); }
    start() { this.starts++; this.state = 'recording'; }
    stop() { this.stops++; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([this.payload], { type: this.mimeType }) }); this.onstop?.(); }
  }
  class Recognition {
    constructor() { recognizers.push(this); }
    start() { this.onstart?.(); }
    stop() {}
    abort() {}
  }
  const scope = { isSecureContext: true, MediaRecorder: media ? Recorder : undefined, SpeechRecognition: recognition ? Recognition : undefined,
    navigator: { userAgent, mediaDevices: { getUserMedia: gum || (async options => { assert.deepEqual(options, { audio: true }); return stream(); }) } } };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/speech/capabilities') return response({ serverStt: { available, provider: available ? 'test-provider' : null, maxBytes: 2097152, maxDurationSeconds: 25, mimeTypes: ['audio/webm', 'audio/mp4'] } });
    return fetchUpload ? fetchUpload(url, options) : response({ text: 'Hello from test transcription', provider: 'test-provider' });
  };
  const speech = new ReliableSpeech({ scope, fetchImpl, onState: state => states.push(state), onError: error => errors.push(error), onHint: hint => hints.push(hint), onTranscript: value => transcripts.push(value) });
  return { speech, scope, Recorder, Recognition, tracks, streams, recorders, recognizers, requests, errors, states, hints, transcripts, stream };
}

test('Android/QQ use configured server STT; desktop retains browser; missing browser STT uses recorder', async t => {
  for (const [userAgent, recognition, expected] of [['Android Chrome', true, 'server'], ['MQQBrowser', true, 'server'], ['Desktop Chrome', true, 'browser'], ['Desktop Chrome', false, 'server']]) {
    const f = fixture({ userAgent, recognition }); t.after(() => f.speech.dispose());
    await f.speech.check(); assert.equal(f.speech.mode, expected); assert.equal(f.speech.state, 'idle'); assert.equal(f.speech.supported, true);
    assert.equal(await f.speech.start(), true);
    assert.equal(f.recorders.length, expected === 'server' ? 1 : 0);
    assert.equal(f.recognizers.length, expected === 'browser' ? 1 : 0);
  }
});

test('missing server config keeps working browser STT and does not claim unsupported phone is ready', async t => {
  for (const recognition of [true, false]) {
    const f = fixture({ userAgent: 'Android', available: false, recognition }); t.after(() => f.speech.dispose());
    await f.speech.check(); assert.equal(f.speech.supported, recognition);
    assert.equal(await f.speech.start(), recognition); assert.equal(f.recorders.length, 0);
    if (!recognition) assert.equal(f.errors.at(-1).code, 'stt-unavailable');
  }
});

test('recorder selects a supported actual MIME and uploads only after recording stops', async t => {
  const f = fixture({ userAgent: 'Android' }); t.after(() => f.speech.dispose());
  await f.speech.check(); await f.speech.start();
  assert.equal(f.tracks[0].readyState, 'live'); assert.equal(f.speech.state, 'listening');
  assert.equal(f.requests.filter(request => request.url.endsWith('transcribe')).length, 0);
  assert.equal(await f.speech.stop(), true); await flush();
  const upload = f.requests.find(request => request.url.endsWith('transcribe'));
  assert.equal(upload.options.method, 'POST'); assert.equal(upload.options.credentials, 'same-origin');
  assert.equal(upload.options.headers['X-Requested-With'], 'ybtc');
  assert.equal(upload.options.headers['Content-Type'], 'audio/webm;codecs=opus');
  assert.ok(upload.options.body instanceof Blob); assert.ok(upload.options.body.size > 0);
  assert.equal(f.tracks[0].readyState, 'ended'); assert.equal(f.speech._recorder._run, null);
  assert.equal(f.transcripts.length, 1); assert.equal(f.transcripts[0].confidence, null); assert.equal(f.speech.state, 'idle');
  assert.equal(selectRecordingMimeType({ isTypeSupported: type => type === 'audio/mp4' }), 'audio/mp4');
});

test('desktop final result goes through once without recording or upload', async t => {
  const f = fixture(); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
  const result = Object.assign([{ transcript: 'A browser test result', confidence: 0.8 }], { isFinal: true });
  f.recognizers[0].onresult({ resultIndex: 0, results: [result] }); f.recognizers[0].onend(); f.recognizers[0].onend();
  assert.equal(f.transcripts.length, 1); assert.equal(f.speech.state, 'idle'); assert.equal(f.recorders.length, 0);
  assert.equal(f.requests.length, 1);
});

test('browser immediate end, aborted, network and timeouts switch once and stay on recorder', async t => {
  for (const code of ['no-final-result', 'aborted', 'network', 'start-timeout', 'stop-timeout']) {
    const f = fixture(); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
    const old = f.recognizers[0];
    if (code === 'no-final-result') old.onend(); else old.onerror({ error: code });
    await flush(); assert.equal(f.speech.mode, 'server'); assert.equal(f.recorders.length, 1); assert.equal(f.speech.state, 'listening');
    assert.match(f.hints.at(-1), /请再说一遍/); assert.equal(f.errors.length, 0);
    old.onerror({ error: 'aborted' }); old.onend(); await flush(); assert.equal(f.recorders.length, 1);
    await f.speech.stop(); await flush(); assert.equal(f.transcripts.length, 1);
    await f.speech.start(); assert.equal(f.recorders.length, 2); assert.equal(f.recognizers.length, 1);
  }
});

test('permission denial does not automatically loop, while the next click can retry', async t => {
  let deny = true;
  const f = fixture({ userAgent: 'Android', gum: async () => { if (deny) throw new DOMException('denied', 'NotAllowedError'); return f.stream(); } });
  t.after(() => f.speech.dispose()); await f.speech.check();
  assert.equal(await f.speech.start(), false); assert.equal(f.errors.at(-1).code, 'not-allowed'); assert.equal(f.speech.state, 'idle'); assert.equal(f.recorders.length, 0);
  deny = false; assert.equal(await f.speech.start(), true); assert.equal(f.recorders.length, 1);
  const desktop = fixture(); t.after(() => desktop.speech.dispose()); await desktop.speech.check(); await desktop.speech.start();
  desktop.recognizers[0].onerror({ error: 'not-allowed' }); await flush(); assert.equal(desktop.recorders.length, 0); assert.equal(desktop.errors.at(-1).code, 'not-allowed');
});

test('one no-speech error is retryable; repeated browser no-speech can use fallback', async t => {
  const f = fixture(); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
  f.recognizers[0].onerror({ error: 'no-speech' }); assert.equal(f.recorders.length, 0); assert.equal(f.speech.state, 'idle');
  await f.speech.start(); f.recognizers[1].onerror({ error: 'no-speech' }); await flush(); assert.equal(f.recorders.length, 1);
});

test('ten recorder cycles reject duplicate starts/stops and never duplicate transcript or leave a live track', async t => {
  const f = fixture({ userAgent: 'Android' }); t.after(() => f.speech.dispose()); await f.speech.check();
  for (let i = 0; i < 10; i++) {
    assert.equal(await f.speech.start(), true); assert.equal(await f.speech.start(), false);
    const old = f.recorders[i], staleStop = old.onstop, staleData = old.ondataavailable;
    assert.equal(await f.speech.stop(), true); assert.equal(await f.speech.stop(), false); await flush();
    staleStop(); staleData({ data: new Blob(['stale']) }); await flush();
    assert.equal(f.transcripts.length, i + 1); assert.equal(f.speech.state, 'idle');
    assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  }
  assert.equal(f.requests.filter(request => request.url.endsWith('transcribe')).length, 10);
});

test('empty audio and byte overflow never upload and release microphone', async t => {
  for (const payload of ['', 'x'.repeat(2097153)]) {
    const f = fixture({ userAgent: 'Android' }); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
    f.recorders[0].payload = payload; await f.speech.stop(); await flush();
    assert.equal(f.errors.at(-1).code, payload ? 'audio-too-large' : 'empty-audio');
    assert.equal(f.requests.length, 1); assert.equal(f.tracks[0].readyState, 'ended'); assert.equal(f.speech.state, 'idle');
  }
});

test('upload failure recovers idle and the next real recording can succeed', async t => {
  let failing = true;
  const f = fixture({ userAgent: 'Android', fetchUpload: async () => failing ? response({ code: 'provider-error' }, 502) : response({ text: 'A retry result' }) });
  t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start(); await f.speech.stop(); await flush();
  assert.equal(f.errors.at(-1).code, 'upload-failed'); assert.equal(f.speech.state, 'idle'); assert.equal(f.transcripts.length, 0);
  failing = false; await f.speech.start(); await f.speech.stop(); await flush(); assert.equal(f.transcripts.length, 1);
});

test('capture duration, stalled stop and stalled upload watchdogs release resources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ userAgent: 'Android' }); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
  t.mock.timers.tick(25000); await flush(); assert.equal(f.transcripts.length, 1); assert.equal(f.tracks[0].readyState, 'ended');
  await f.speech.start(); f.recorders[1].stop = function () { this.state = 'inactive'; };
  await f.speech.stop(); t.mock.timers.tick(4000); await flush(); assert.equal(f.errors.at(-1).code, 'recording-stop-timeout'); assert.equal(f.speech.state, 'idle');
  const stalled = fixture({ userAgent: 'Android', fetchUpload: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  t.after(() => stalled.speech.dispose()); await stalled.speech.check(); await stalled.speech.start(); await stalled.speech.stop(); await flush();
  t.mock.timers.tick(45000); await flush(); assert.equal(stalled.errors.at(-1).code, 'upload-timeout'); assert.equal(stalled.speech.state, 'idle');
  assert.equal(stalled.requests.at(-1).options.signal.aborted, true);
});

test('permission timeout and disposal stop tracks granted later without starting recorder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const disposed of [false, true]) {
    const pending = deferred(); const f = fixture({ userAgent: 'Android', gum: () => pending.promise }); t.after(() => f.speech.dispose());
    await f.speech.check(); const starting = f.speech.start(); await flush();
    if (disposed) await f.speech.dispose(); else t.mock.timers.tick(15000);
    await flush(); assert.equal(await starting, false);
    pending.resolve(f.stream()); await flush();
    assert.equal(f.tracks[0].readyState, 'ended'); assert.equal(f.recorders.length, 0);
    if (!disposed) assert.equal(f.errors.at(-1).code, 'permission-timeout');
  }
});

test('dispose aborts upload and ignores its late response', async t => {
  const pending = deferred(); const f = fixture({ userAgent: 'Android', fetchUpload: () => pending.promise });
  t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start(); await f.speech.stop(); await flush();
  const request = f.requests.at(-1); await f.speech.dispose();
  assert.equal(request.options.signal.aborted, true); pending.resolve(response({ text: 'Late result' })); await flush();
  assert.equal(f.transcripts.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.speech.state, 'idle');
});

test('insecure or disabled audio tracks cannot start recording', async t => {
  const f = fixture({ userAgent: 'Android', gum: async () => { const stream = f.stream(); stream.getAudioTracks()[0].enabled = false; return stream; } });
  t.after(() => f.speech.dispose()); await f.speech.check(); assert.equal(await f.speech.start(), false);
  assert.equal(f.errors.at(-1).code, 'audio-capture'); assert.equal(f.tracks[0].readyState, 'ended');
  const errors = []; const recorder = new MemoryAudioRecorder({ scope: { isSecureContext: false }, onError: error => errors.push(error) });
  assert.equal(await recorder.start(), false); assert.equal(errors[0].code, 'insecure-context');
});

test('server no-speech and timeout codes produce distinct retry hints and release input state', async t => {
  for (const [code, status, expected] of [['STT_NO_SPEECH', 422, 'no-speech'], ['STT_TIMEOUT', 504, 'upload-timeout']]) {
    const f = fixture({ userAgent: 'Android', fetchUpload: async () => response({ code }, status) });
    t.after(() => f.speech.dispose());
    await f.speech.check(); await f.speech.start(); await f.speech.stop(); await flush();
    assert.equal(f.speech.state, 'idle');
    assert.equal(f.errors.at(-1).code, expected);
    assert.match(f.errors.at(-1).detail, new RegExp(code));
    assert.equal(f.transcripts.length, 0);
    assert.equal(await f.speech.start(), true);
  }
});
