const OPTIONS = Object.freeze({ langs: ['en-US'], processLocally: true });
const AVAILABILITIES = new Set(['available', 'downloadable', 'downloading', 'unavailable']);
const ERRORS = {
  'insecure-context': '语音需要通过 HTTPS 网站或 localhost 访问；请使用最新版 Chrome 或 Edge。现在可以使用文字练习。',
  unsupported: '当前浏览器不支持英语语音识别，请在系统浏览器中使用最新版 Chrome 或 Edge。',
  'not-allowed': '麦克风权限未获允许，请检查浏览器的网站权限和系统麦克风设置。',
  'service-not-allowed': '浏览器不允许使用当前语音识别服务，请检查浏览器或组织策略；这不等同于麦克风权限被拒绝。',
  'language-not-supported': '当前识别服务不支持所选英语语言。',
  'audio-capture': '无法读取麦克风，请检查设备连接、系统权限，以及麦克风是否被其他程序占用。',
  'no-speech': '没有检测到清晰的英语，请靠近麦克风再试一次。',
  'no-final-result': '浏览器已结束识别，但没有返回最终英文文本。请重试，或在正常Chrome/Edge中检查。',
  network: '浏览器语音识别服务连接失败，请检查网络及该浏览器语音服务是否可达。',
  aborted: '本次收音已结束，可以再次点击麦克风开始。',
  'start-timeout': '麦克风未能及时启动，请检查权限和设备后重试。',
  'stop-timeout': '语音服务没有及时结束，本次收音已取消，请重试。',
  'start-failed': '语音识别未能启动，请查看错误代码后重试。'
};
function errorCode(error, fallback = 'start-failed') {
  return error?.name === 'AbortError' ? 'aborted' : error?.error || error?.name || fallback;
}

/** Optional on-device STT, with ordinary Web Speech fallback. No audio recording or app upload. */
export class LocalSpeech {
  constructor({ Recognition, secure = globalThis.isSecureContext === true, onState = () => {}, onHint = () => {}, onTranscript = () => {}, onError = () => {} } = {}) {
    this.Recognition = Recognition ?? globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    this.secure = secure;
    this.onState = onState; this.onHint = onHint; this.onTranscript = onTranscript; this.onError = onError;
    this.state = 'idle'; this.availability = 'unavailable'; this.mode = 'browser';
    this.supported = this._hasSupport();
    this._disposed = false; this._active = null; this._checkPromise = null;
  }

  _hasSupport() {
    return !!(this.secure && typeof this.Recognition === 'function');
  }
  _state(state) { if (this.state !== state) { this.state = state; this.onState(state); } }
  _error(code, detail = '', source = 'client') { const message = ERRORS[code] || ERRORS['start-failed']; this.onHint(message); this.onError({ code, message, detail, source }); }
  _alive(run) { return !this._disposed && this._active === run; }

  async _query() {
    let timer;
    try {
      const result = await Promise.race([
        this.Recognition.available({ ...OPTIONS, langs: [...OPTIONS.langs] }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'check-timeout' })), 1500); })
      ]);
      if (!AVAILABILITIES.has(result)) throw new Error('Unexpected availability');
      return result;
    } finally { clearTimeout(timer); }
  }

  check() {
    if (this._disposed) return Promise.resolve('unavailable');
    if (this._active) return Promise.resolve(this.availability);
    if (this._checkPromise) return this._checkPromise;
    this.supported = this._hasSupport();
    if (!this.supported) {
      this.availability = 'unavailable'; this._error(this.secure ? 'unsupported' : 'insecure-context');
      return Promise.resolve(this.availability);
    }
    this.mode = 'browser';
    const fallback = detail => this.onHint(`使用浏览器英语识别${detail ? `（本地识别：${detail}）` : ''}。点击麦克风开始；浏览器可能使用在线语音服务。`);
    if (!('processLocally' in this.Recognition.prototype) || typeof this.Recognition.available !== 'function') {
      this.availability = 'unavailable'; fallback(); return Promise.resolve(this.availability);
    }
    this._state('checking');
    this._checkPromise = Promise.resolve().then(async () => {
      try {
        const availability = await this._query();
        if (this._disposed) return 'unavailable';
        this.availability = availability;
        this.mode = availability === 'available' ? 'local' : 'browser';
        if (this.mode === 'local') this.onHint('本地英语识别已就绪。点击麦克风开始，说完后可以再次点击停止。');
        else fallback(availability);
        return availability;
      } catch (error) {
        if (!this._disposed) { this.availability = 'unavailable'; this.mode = 'browser'; fallback(error.code || error.name || 'check-failed'); }
        return 'unavailable';
      } finally {
        this._checkPromise = null;
        if (!this._disposed && !this._active) this._state('idle');
      }
    });
    return this._checkPromise;
  }

  async start() {
    if (this._disposed || this._active || this._checkPromise) return false;
    this.supported = this._hasSupport();
    if (!this.supported) { this._error(this.secure ? 'unsupported' : 'insecure-context'); return false; }
    let run;
    try {
      const recognition = new this.Recognition();
      // Do not set processLocally at all on the ordinary Web Speech path.
      if (this.mode === 'local') recognition.processLocally = true;
      recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true; recognition.maxAlternatives = 1;
      run = { recognition, finals: new Map(), startup: null, utterance: null, stopping: null };
      this._active = run;
      recognition.onstart = () => {
        if (!this._alive(run)) return;
        clearTimeout(run.startup);
        if (run.stopping) return;
        this._state('listening'); this.onHint('正在倾听，请说英语…');
        run.utterance = setTimeout(() => { if (this._alive(run)) void this.stop(); }, 25000);
      };
      for (const [event, hint] of Object.entries({ audiostart: '麦克风已打开，请说英语。', soundstart: '已经听到声音，请继续说英语。', speechstart: '已经听到你说英语了，请继续。', speechend: '正在整理你说的英语…', soundend: '声音已停止，正在等待识别结果…', audioend: '收音已结束，正在等待识别结果…' })) {
        recognition[`on${event}`] = () => {
          if (!this._alive(run)) return;
          if (event === 'speechend' || event === 'audioend') this._state('processing');
          this.onHint(hint);
        };
      }
      recognition.onresult = event => {
        if (!this._alive(run)) return;
        const results = event.results;
        const from = Number.isInteger(event.resultIndex) ? Math.max(0, event.resultIndex) : 0;
        for (let i = from; i < results.length; i++) {
          if (!results[i].isFinal) continue;
          const match = results[i][0]; const text = match?.transcript?.trim();
          if (text) run.finals.set(i, { text, confidence: Number.isFinite(match.confidence) && match.confidence >= 0 && match.confidence <= 1 ? match.confidence : null });
        }
        const preview = Array.from(results, result => result[0]?.transcript?.trim()).filter(Boolean).join(' ');
        if (preview) this.onHint(`听到了：${preview}`);
      };
      recognition.onerror = event => {
        if (!this._alive(run)) return;
        if (this.mode === 'local' && ['language-not-supported', 'service-not-allowed'].includes(event.error)) {
          this.availability = 'unavailable'; this.mode = 'browser';
        }
        this._finish(run, event.error || 'start-failed', event.message || '', 'browser');
      };
      recognition.onend = () => this._finish(run);
      this._state('checking'); this.onHint(`正在启动${this.mode === 'local' ? '本地' : '浏览器'}英语识别，请留意麦克风权限提示。`);
      run.startup = setTimeout(() => this._finish(run, 'start-timeout'), 8000);
      // No await on this ready path: preserve the user's microphone-button activation.
      recognition.start();
      return this._alive(run);
    } catch (error) {
      const code = errorCode(error);
      if (run) this._finish(run, code, error.message || '', 'browser');
      else this._error(code, error.message || '', 'browser');
      return false;
    }
  }

  _finish(run, error, detail = '', source = 'client') {
    if (!this._alive(run)) return;
    clearTimeout(run.startup); clearTimeout(run.utterance); clearTimeout(run.stopping);
    this._active = null; this._state('idle');
    if (error && error !== 'aborted') {
      try { run.recognition.abort(); } catch { /* The service may already be stopped. */ }
      this._error(error, detail, source); return;
    }
    const finals = [...run.finals.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
    if (!finals.length) {
      if (error === 'aborted') {
        const message = ERRORS.aborted;
        this.onHint(message);
        this.onError({ code: 'aborted', message, detail, source, recoverable: true });
      } else this._error('no-final-result');
      return;
    }
    const measured = finals.filter(value => value.confidence !== null);
    const weight = measured.reduce((total, value) => total + value.text.length, 0);
    const confidence = weight ? measured.reduce((total, value) => total + value.confidence * value.text.length, 0) / weight : null;
    this.onTranscript({ text: finals.map(value => value.text).join(' '), confidence });
  }

  async stop() {
    const run = this._active;
    if (!run || this._disposed || run.stopping) return false;
    clearTimeout(run.startup); clearTimeout(run.utterance);
    run.stopping = setTimeout(() => this._finish(run, 'stop-timeout'), 5000);
    this._state('processing');
    this.onHint('收音即将结束，正在整理识别结果…');
    try { run.recognition.stop(); return true; }
    catch (error) { this._finish(run, errorCode(error, 'aborted'), error.message || '', 'browser'); return false; }
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const run = this._active; this._active = null;
    if (run) {
      clearTimeout(run.startup); clearTimeout(run.utterance); clearTimeout(run.stopping);
      try { run.recognition.abort(); } catch { /* Disposing is safe after browser shutdown. */ }
    }
    this.availability = 'unavailable'; this._state('idle');
  }
}
