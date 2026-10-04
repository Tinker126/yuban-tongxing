import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSpeech } from '../public/local-speech.js';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const calls = [], instances = [], states = [], hints = [], transcripts = [], errors = [];
  class Recognition {
    static availability = 'available';
    static available(options) { calls.push(['available', options]); return Promise.resolve(this.availability); }
    static install(options) { calls.push(['install', options]); this.availability = 'available'; return Promise.resolve(true); }
    constructor() { instances.push(this); }
    start() { calls.push(['start', this.processLocally]); this.onstart?.(); }
    stop() { calls.push(['stop']); }
    abort() { calls.push(['abort']); }
  }
  Recognition.prototype.processLocally = false;
  const speech = new LocalSpeech({ Recognition, secure: true, onState: value => states.push(value), onHint: value => hints.push(value), onTranscript: value => transcripts.push(value), onError: value => errors.push(value) });
  return { speech, Recognition, calls, instances, states, hints, transcripts, errors };
}
function result(text, isFinal, confidence) { return Object.assign([{ transcript: text, confidence }], { isFinal }); }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('available on-device recognition remains optional and starts synchronously', async t => {
  const f = fixture(); t.after(() => f.speech.dispose());
  assert.equal(await f.speech.check(), 'available');
  const starting = f.speech.start();
  assert.deepEqual(f.calls.at(-1), ['start', true]);
  assert.equal(await starting, true);
  assert.equal(f.instances[0].lang, 'en-US');
  assert.equal(f.instances[0].continuous, false);
  assert.equal(f.instances[0].interimResults, true);
  assert.equal(f.calls[0][1].processLocally, true);
  assert.equal(f.speech.mode, 'local');
  assert.equal(f.calls.some(call => call[0] === 'install'), false);
});

test('unsupported and insecure environments never instantiate a recognizer', async () => {
  for (const kind of ['unsupported', 'insecure']) {
    const f = fixture();
    if (kind === 'unsupported') f.speech.Recognition = undefined;
    else f.speech.secure = false;
    assert.equal(await f.speech.check(), 'unavailable');
    assert.equal(f.speech.supported, false);
    assert.equal(await f.speech.start(), false);
    assert.equal(f.instances.length, 0);
    assert.equal(f.errors.at(-1).code, kind === 'unsupported' ? 'unsupported' : 'insecure-context');
  }
});

test('ordinary SpeechRecognition works without either on-device extension', async t => {
  for (const missing of ['both', 'processLocally', 'available']) {
    const f = fixture(); t.after(() => f.speech.dispose());
    if (missing !== 'available') delete f.Recognition.prototype.processLocally;
    if (missing !== 'processLocally') delete f.Recognition.available;
    assert.equal(await f.speech.check(), 'unavailable');
    assert.equal(f.speech.supported, true);
    assert.equal(f.speech.mode, 'browser');
    assert.equal(f.speech.state, 'idle');
    const starting = f.speech.start();
    assert.equal(f.instances.length, 1); // Preserve button activation: no availability await before start.
    assert.equal(await starting, true);
    assert.equal(Object.hasOwn(f.instances[0], 'processLocally'), false);
    assert.equal(f.instances[0].lang, 'en-US');
    assert.equal(f.calls.some(call => call[0] === 'available' || call[0] === 'install'), false);
    assert.equal(f.errors.length, 0);
  }
});

test('unavailable or uninstalled language models use ordinary recognition without installation', async t => {
  for (const availability of ['unavailable', 'downloadable', 'downloading']) {
    const f = fixture(); t.after(() => f.speech.dispose());
    f.Recognition.availability = availability;
    assert.equal(await f.speech.check(), availability);
    assert.equal(f.speech.supported, true);
    assert.equal(f.speech.mode, 'browser');
    assert.equal(f.speech.state, 'idle');
    assert.equal(await f.speech.start(), true);
    assert.equal(Object.hasOwn(f.instances[0], 'processLocally'), false);
    assert.deepEqual(f.calls.at(-1), ['start', false]);
    assert.equal(f.calls.some(call => call[0] === 'install'), false);
    assert.equal(f.errors.length, 0);
  }
});

test('availability failure falls back and a later explicit check can discover local support', async () => {
  const f = fixture();
  f.Recognition.available = () => Promise.reject(new Error('temporarily unavailable'));
  assert.equal(await f.speech.check(), 'unavailable');
  assert.equal(f.speech.state, 'idle');
  assert.equal(f.speech.mode, 'browser');
  assert.equal(f.speech.supported, true);
  assert.equal(f.errors.length, 0);
  assert.equal(await f.speech.start(), true);
  assert.equal(Object.hasOwn(f.instances[0], 'processLocally'), false);
  f.instances[0].onend();
  f.Recognition.available = () => Promise.resolve('available');
  assert.equal(await f.speech.check(), 'available');
  assert.equal(f.speech.supported, true);
  assert.equal(f.speech.mode, 'local');
  assert.equal(f.calls.some(call => call[0] === 'install'), false);
});

test('timed-out local availability falls back without accepting a stale late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), pending = deferred(); t.after(() => f.speech.dispose());
  f.Recognition.available = () => pending.promise;
  const checking = f.speech.check();
  assert.equal(f.speech.check(), checking);
  await flush();
  assert.equal(f.speech.state, 'checking');
  assert.equal(await f.speech.start(), false);
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(await checking, 'unavailable');
  assert.equal(f.speech.state, 'idle');
  assert.equal(f.speech.mode, 'browser');
  assert.match(f.hints.at(-1), /check-timeout/);
  assert.equal(f.errors.length, 0);
  pending.resolve('available'); await flush();
  assert.equal(f.speech.mode, 'browser');
  assert.equal(f.speech.availability, 'unavailable');
  assert.equal(await f.speech.start(), true);
  assert.equal(Object.hasOwn(f.instances[0], 'processLocally'), false);
  assert.equal(f.calls.some(call => call[0] === 'install'), false);
});

test('final segments assemble by resultIndex; interim speech is only a hint', async () => {
  const f = fixture(); await f.speech.check(); await f.speech.start();
  const rec = f.instances[0];
  rec.onresult({ resultIndex: 0, results: [result('Hello', false, 0.2)] });
  assert.equal(f.transcripts.length, 0); assert.match(f.hints.at(-1), /Hello/);
  rec.onresult({ resultIndex: 0, results: [result('Hello', true, 0.9), result('my', false)] });
  rec.onresult({ resultIndex: 1, results: [result('Hello', true, 0.9), result('my friend', true, 0.6), result('discard me', false)] });
  await f.speech.stop();
  assert.equal(f.speech.state, 'processing'); assert.equal(f.transcripts.length, 0);
  rec.onend(); rec.onend();
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.transcripts[0].text, 'Hello my friend');
  assert.ok(Math.abs(f.transcripts[0].confidence - (5 * 0.9 + 9 * 0.6) / 14) < 1e-12);
  assert.equal(f.speech.state, 'idle');
});

test('missing confidence stays null and interim-only sessions are not submitted', async () => {
  const f = fixture(); await f.speech.check(); await f.speech.start();
  f.instances[0].onresult({ resultIndex: 0, results: [result('Hello', true)] }); f.instances[0].onend();
  assert.deepEqual(f.transcripts[0], { text: 'Hello', confidence: null });
  await f.speech.start();
  f.instances[1].onresult({ resultIndex: 0, results: [result('not final', false)] }); f.instances[1].onend();
  assert.equal(f.transcripts.length, 1); assert.equal(f.errors.at(-1).code, 'no-final-result');
});

test('specific errors recover without requiring end; stale callbacks cannot change a new session', async t => {
  const f = fixture(); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
  const old = f.instances[0];
  old.onerror({ error: 'not-allowed' });
  assert.equal(f.speech.state, 'idle'); assert.equal(f.errors.at(-1).code, 'not-allowed');
  await f.speech.start();
  old.onerror({ error: 'service-not-allowed' }); old.onend(); old.onstart();
  old.onresult({ resultIndex: 0, results: [result('stale', true)] });
  assert.equal(f.speech.state, 'listening'); assert.equal(f.speech.availability, 'available');
  assert.equal(f.errors.length, 1); assert.equal(f.transcripts.length, 0);
});

test('all browser error codes receive distinct useful messages', async () => {
  const codes = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'no-speech', 'network', 'aborted'];
  const messages = new Set();
  for (const code of codes) {
    const f = fixture(); await f.speech.check(); await f.speech.start(); f.instances[0].onerror({ error: code, message: 'native detail' });
    assert.equal(f.errors[0].code, code); messages.add(f.errors[0].message); assert.equal(f.speech.state, 'idle');
    assert.equal(f.errors[0].detail, 'native detail'); assert.equal(f.errors[0].source, 'browser');
  }
  assert.equal(messages.size, codes.length);
});

test('an aborted mobile recognition is recoverable and the next click creates a fresh instance', async t => {
  const f = fixture(); t.after(() => f.speech.dispose());
  await f.speech.check();
  assert.equal(await f.speech.start(), true);
  const first = f.instances[0];
  first.onerror({ error: 'aborted' });
  assert.equal(f.speech.state, 'idle');
  assert.equal(f.errors.at(-1).code, 'aborted');
  assert.equal(f.errors.at(-1).recoverable, true);
  assert.match(f.hints.at(-1), /再次点击麦克风/);
  assert.equal(f.calls.some(call => call[0] === 'abort'), false);

  assert.equal(await f.speech.start(), true);
  assert.equal(f.instances.length, 2);
  assert.notEqual(f.instances[1], first);
  first.onend(); // A stale end event from Android must not disturb the new recognizer.
  assert.equal(f.speech.state, 'listening');
});

test('a final transcript is kept if the browser then reports aborted', async t => {
  const f = fixture(); t.after(() => f.speech.dispose());
  await f.speech.start();
  f.instances[0].onresult({ resultIndex: 0, results: [result('Hello there', true, 0.8)] });
  f.instances[0].onerror({ error: 'aborted' });
  assert.deepEqual(f.transcripts[0], { text: 'Hello there', confidence: 0.8 });
  assert.equal(f.speech.state, 'idle');
  assert.equal(f.errors.length, 0);
});

test('AbortError exceptions are also recoverable on the next microphone click', async t => {
  const f = fixture(); t.after(() => f.speech.dispose());
  f.Recognition.prototype.start = function () { throw new DOMException('recognizer was interrupted', 'AbortError'); };
  assert.equal(await f.speech.start(), false);
  assert.equal(f.errors.at(-1).code, 'aborted');
  assert.equal(f.errors.at(-1).recoverable, true);
  f.Recognition.prototype.start = function () { this.onstart(); };
  assert.equal(await f.speech.start(), true);
  assert.equal(f.instances.length, 2);
});

test('startup watchdog releases the UI; maximum utterance requests stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.Recognition.prototype.start = function () {};
  await f.speech.check(); await f.speech.start();
  t.mock.timers.tick(8000);
  assert.equal(f.speech.state, 'idle'); assert.equal(f.errors.at(-1).code, 'start-timeout');
  f.Recognition.prototype.start = function () { this.onstart(); };
  await f.speech.start(); t.mock.timers.tick(25000);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  assert.equal(f.speech.state, 'processing');
  f.instances[1].onend(); assert.equal(f.speech.state, 'idle');
});

test('ten consecutive start-stop cycles reject duplicate starts and stops without automatic restart', async () => {
  for (const availability of ['available', 'unavailable']) {
    const f = fixture(); f.Recognition.availability = availability; await f.speech.check();
    for (let i = 0; i < 10; i++) {
      assert.equal(await f.speech.start(), true);
      assert.equal(await f.speech.start(), false);
      assert.equal(f.speech.state, 'listening');
      assert.equal(await f.speech.stop(), true);
      assert.equal(await f.speech.stop(), false);
      assert.equal(f.speech.state, 'processing');
      assert.equal(await f.speech.start(), false);
      const rec = f.instances[i]; rec.onend(); rec.onend();
      assert.equal(f.speech.state, 'idle');
      assert.equal(f.instances.length, i+1);
      assert.equal(f.calls.filter(call => call[0] === 'start').length, i+1);
    }
    assert.equal(f.calls.filter(call => call[0] === 'stop').length, 10);
    assert.equal(f.transcripts.length, 0); // Lifecycle test only, not a spoken-input acceptance test.
  }
});

test('native start exception preserves its actual name and message and unlocks retry', async () => {
  const f = fixture(); await f.speech.check();
  f.Recognition.prototype.start = function () { throw Object.assign(new Error('native engine already running'), {name:'InvalidStateError'}); };
  assert.equal(await f.speech.start(), false);
  assert.equal(f.errors.at(-1).code, 'InvalidStateError');
  assert.equal(f.errors.at(-1).detail, 'native engine already running');
  assert.equal(f.speech.state, 'idle');
  f.Recognition.prototype.start = function () { this.onstart(); };
  assert.equal(await f.speech.start(), true); await f.speech.dispose();
});

test('local service rejection enables ordinary recognition on the next deliberate click', async t => {
  for (const code of ['language-not-supported', 'service-not-allowed']) {
    const f = fixture(); t.after(() => f.speech.dispose()); await f.speech.check(); await f.speech.start();
    const previous = f.instances[0]; previous.onerror({ error: code });
    assert.equal(f.speech.mode, 'browser'); assert.equal(f.speech.supported, true);
    assert.equal(f.speech.state, 'idle'); assert.equal(f.errors.at(-1).code, code);
    assert.equal(f.instances.length, 1); // No hidden restart or extra recording.
    assert.equal(await f.speech.start(), true);
    assert.equal(Object.hasOwn(f.instances[1], 'processLocally'), false);
    previous.onend(); assert.equal(f.speech.state, 'listening');
  }
});

test('stop before a delayed onstart stays processing and timeout allows retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.speech.dispose());
  f.Recognition.prototype.start = function () {};
  await f.speech.start(); await f.speech.stop(); f.instances[0].onstart();
  assert.equal(f.speech.state, 'processing');
  t.mock.timers.tick(5000);
  assert.equal(f.speech.state, 'idle'); assert.equal(f.errors.at(-1).code, 'stop-timeout');
  f.Recognition.prototype.start = function () { this.onstart(); };
  assert.equal(await f.speech.start(), true);
});

test('dispose aborts recording and suppresses pending availability callbacks', async () => {
  const f = fixture(); await f.speech.check(); await f.speech.start(); await f.speech.dispose();
  const hintCount = f.hints.length;
  f.instances[0].onend(); f.instances[0].onerror({ error: 'aborted' });
  assert.equal(f.hints.length, hintCount); assert.equal(f.calls.at(-1)[0], 'abort');
  const g = fixture(), query = deferred();
  g.Recognition.available = () => query.promise;
  const pending = g.speech.check(); await flush(); await g.speech.dispose();
  const count = g.hints.length; query.resolve('available'); assert.equal(await pending, 'unavailable');
  assert.equal(g.hints.length, count); assert.equal(g.speech.availability, 'unavailable');
});
