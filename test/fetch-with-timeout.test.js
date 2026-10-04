import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../public/fetch-with-timeout.js';

test('request timeout uses AbortController and setTimeout without AbortSignal.timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  t.after(() => {
    if (original) Object.defineProperty(AbortSignal, 'timeout', original);
    else delete AbortSignal.timeout;
  });

  let receivedSignal;
  const request = fetchWithTimeout((_input, options) => {
    receivedSignal = options.signal;
    return new Promise((_, reject) => receivedSignal.addEventListener('abort', () => reject(new Error('aborted'))));
  }, '/api/auth/login', { method: 'POST' }, 250);
  assert.equal(receivedSignal.aborted, false);
  t.mock.timers.tick(250);
  await assert.rejects(request, error => error.name === 'TimeoutError');
  assert.equal(receivedSignal.aborted, true);
});
