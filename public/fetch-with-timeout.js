/** Fetch with an AbortController timer; does not depend on AbortSignal.timeout(). */
export async function fetchWithTimeout(fetchImpl, input, options = {}, timeoutMs = 55000) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (typeof globalThis.AbortController !== 'function') {
    throw new Error('This browser does not support request cancellation. Please update the browser.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, Number(timeoutMs) || 0));

  try {
    return await fetchImpl(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('Request timed out.');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
