import { LocalSpeech } from './local-speech.js';
import { MemoryAudioRecorder } from './audio-recorder.js';

const FALLBACK_ERRORS = new Set(['no-final-result', 'aborted', 'network', 'service-not-allowed', 'language-not-supported', 'start-timeout', 'stop-timeout', 'start-failed', 'InvalidStateError']);
const SERVER_ERRORS = {
  STT_NO_SPEECH: 'no-speech', STT_EMPTY_AUDIO: 'empty-audio', STT_INVALID_AUDIO: 'recording-failed',
  STT_AUDIO_TOO_LARGE: 'audio-too-large', STT_AUDIO_TOO_LONG: 'audio-too-long',
  STT_UNSUPPORTED_AUDIO: 'unsupported-audio', STT_BUSY: 'stt-busy', STT_UNAVAILABLE: 'stt-unavailable',
  STT_PROVIDER_ERROR: 'upload-failed', STT_TIMEOUT: 'upload-timeout', STT_ABORTED: 'aborted',
  STT_PROVIDER_AUTH: 'service-configuration', STT_PROVIDER_NOT_ACTIVATED: 'service-configuration', STT_PROVIDER_QUOTA: 'daily-limit',
  STT_RATE_LIMITED: 'rate-limited', STT_DAILY_LIMIT: 'daily-limit', STT_UNAUTHENTICATED: 'login-required'
};
const MESSAGES = {
  'insecure-context': '麦克风需要 HTTPS，请通过网站的 HTTPS 地址访问。',
  'recorder-unsupported': '当前浏览器无法录制语音，请使用最新版 Chrome 或 Edge，并检查系统麦克风权限。',
  'stt-unavailable': '服务器英语识别暂不可用，请稍后重试；现在可以使用文字练习。',
  'not-allowed': '麦克风权限被拒绝，请在浏览器和手机系统中允许麦克风，然后再次点击。',
  'audio-capture': '无法获得正常的麦克风音轨，请检查设备权限或其他应用是否占用麦克风。',
  'permission-timeout': '等待麦克风权限超时，请允许权限后再次点击麦克风。',
  'empty-audio': '本次录音没有产生音频，请检查麦克风后重试。',
  'audio-too-large': '本次录音超过大小限制，请缩短句子后重试。',
  'audio-too-long': '本次录音较长，请用一句简短英语重试。',
  'unsupported-audio': '浏览器生成的录音格式暂不支持，请使用最新版 Chrome 或 Edge 重试。',
  'stt-busy': '现在正在识别的同学较多，请稍等片刻再试。',
  'daily-limit': '今天的语音识别额度已用完，请联系老师。',
  'service-configuration': '服务器语音识别尚未开通或授权配置有误，请联系老师；可以先使用文字练习。',
  'recording-stop-timeout': '录音未能正常结束，麦克风已关闭，请重试。',
  'recording-failed': '录音未能完成，请检查麦克风权限并重试。',
  'upload-timeout': '英语识别请求超时，请检查网络后重新说一句。',
  'upload-failed': '英语识别服务暂时连接失败，请稍后再次点击麦克风。',
  'no-speech': '没有识别到清晰英语，请靠近麦克风再说一遍。',
  'login-required': '登录已失效，请重新登录后使用服务器英语识别。',
  'rate-limited': '语音请求较多，请稍等片刻再试。',
  aborted: '本次录音已取消，可以再次点击麦克风。'
};

/** Keeps working browser STT and adds short-lived server transcription for unreliable devices. */
export class ReliableSpeech {
  constructor({ Recognition, secure, scope = globalThis, fetchImpl,
    onState = () => {}, onHint = () => {}, onTranscript = () => {}, onError = () => {},
    LocalSpeechClass = LocalSpeech, RecorderClass = MemoryAudioRecorder, uploadTimeoutMs = 45000,
    capabilityTimeoutMs = 6000, recorderOptions = {} } = {}) {
    this.scope = scope; this.secure = secure ?? scope.isSecureContext === true;
    this.Recognition = Recognition ?? scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
    this.fetchImpl = fetchImpl || scope.fetch?.bind(scope); this.RecorderClass = RecorderClass;
    this.onState = onState; this.onHint = onHint; this.onTranscript = onTranscript; this.onError = onError;
    this.uploadTimeoutMs = uploadTimeoutMs; this.capabilityTimeoutMs = capabilityTimeoutMs; this.recorderOptions = recorderOptions;
    this.state = 'idle'; this.mode = 'browser'; this.availability = 'unavailable'; this._disposed = false;
    this._attempt = null; this._checkPromise = null; this._capabilityController = null; this._recorder = null;
    this._server = { available: false }; this._stickyRecorder = false; this._noSpeechFailures = 0;
    this._preferRecorder = /Android|MQQBrowser|QQBrowser/i.test(scope.navigator?.userAgent || '');
    this.supported = this._browserSupported();
    this._browser = new LocalSpeechClass({ Recognition: this.Recognition, secure: this.secure,
      onState: state => { if (!this._disposed && this.mode === 'browser') this._state(state); },
      onHint: hint => { if (!this._disposed && this.mode === 'browser') this.onHint(hint); },
      onError: error => this._browserError(error),
      onTranscript: result => {
        if (this._disposed || this._attempt?.path !== 'browser') return;
        this._attempt = null; this._noSpeechFailures = 0; this._state('idle'); this.onTranscript(result);
      }
    });
    this._pagehide = () => { void this.dispose(); };
    scope.addEventListener?.('pagehide', this._pagehide);
  }

  _browserSupported() { return this.secure && typeof this.Recognition === 'function'; }
  _recorderSupported() { return this.secure && typeof this.scope.navigator?.mediaDevices?.getUserMedia === 'function' && typeof this.scope.MediaRecorder === 'function'; }
  _canRecord() { return this._server.available && this._recorderSupported(); }
  _state(value) { if (this.state !== value) { this.state = value; this.onState(value); } }
  _error(code, detail = '') {
    const message = MESSAGES[code] || MESSAGES['upload-failed'];
    this.onHint(message); this.onError({ code, message, detail, source: 'server-stt', recoverable: code === 'aborted' });
  }

  async _request(url, options, timeoutMs, controller) {
    let timer, removeAbort;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
          return { ok: response.ok, status: response.status, data: await response.json() };
        }),
        new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error(), { name: 'AbortError' }));
          controller.signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => controller.signal.removeEventListener('abort', abort);
          timer = setTimeout(() => {
            reject(Object.assign(new Error(), { name: 'TimeoutError' })); controller.abort();
          }, timeoutMs);
          if (controller.signal.aborted) abort();
        })
      ]);
    } finally { clearTimeout(timer); removeAbort?.(); }
  }

  check() {
    if (this._disposed) return Promise.resolve('unavailable');
    if (this._attempt) return Promise.resolve(this.availability);
    if (this._checkPromise) return this._checkPromise;
    this._state('checking');
    this._checkPromise = Promise.resolve().then(async () => {
      try {
        if (this.secure && typeof this.fetchImpl === 'function') {
          this._capabilityController = new AbortController();
          const response = await this._request('/api/speech/capabilities', { credentials: 'same-origin' }, this.capabilityTimeoutMs, this._capabilityController);
          const data = response.ok ? response.data : null;
          this._server = data?.serverStt?.available === true ? data.serverStt : { available: false };
        }
      } catch { this._server = { available: false }; }
      finally { this._capabilityController = null; }
      if (this._disposed) return 'unavailable';
      this.supported = this._browserSupported() || this._canRecord();
      if (!this.supported) {
        this.availability = 'unavailable'; this._error(!this.secure ? 'insecure-context' : this._recorderSupported() ? 'stt-unavailable' : 'recorder-unsupported');
        return this.availability;
      }
      if (this._canRecord() && (this._preferRecorder || this._stickyRecorder || !this._browserSupported())) {
        this.mode = 'server'; this.availability = 'available';
        this.onHint('服务器英语识别已就绪。录音仅用于本次转写，不保存原始音频；说完可点击麦克风结束。');
      } else {
        this.mode = 'browser'; this.availability = await this._browser.check();
        if (this._disposed) return 'unavailable';
        if (!this._server.available && this._preferRecorder) this.onHint('服务器英语识别暂不可用，当前使用浏览器识别；失败后可稍后再试或用文字练习。');
      }
      return this.availability;
    }).finally(() => { this._checkPromise = null; if (!this._disposed && !this._attempt) this._state('idle'); });
    return this._checkPromise;
  }

  async start() {
    if (this._disposed || this._attempt || this._checkPromise || this.state !== 'idle') return false;
    if (this._canRecord() && (this.mode === 'server' || this._stickyRecorder || this._preferRecorder || !this._browserSupported())) return this._startRecording();
    if (!this._browserSupported()) { this._error(!this.secure ? 'insecure-context' : this._recorderSupported() ? 'stt-unavailable' : 'recorder-unsupported'); return false; }
    this.mode = 'browser';
    const attempt = { path: 'browser' }; this._attempt = attempt;
    const started = await this._browser.start();
    if (!started && this._attempt === attempt) { this._attempt = null; this._state('idle'); }
    return started || this._attempt?.path === 'server';
  }

  _browserError(error) {
    if (this._disposed) return;
    if (this._attempt?.path !== 'browser') return;
    this._attempt = null;
    if (error.code === 'no-speech') this._noSpeechFailures++;
    if (this._canRecord() && (FALLBACK_ERRORS.has(error.code) || (error.code === 'no-speech' && this._noSpeechFailures >= 2))) {
      this._stickyRecorder = true;
      void this._startRecording(true); return;
    }
    this._state('idle'); this.onError(error);
  }

  async _startRecording(fallback = false) {
    if (this._disposed || this._attempt) return false;
    this.mode = 'server';
    const attempt = { path: 'server', controller: null }; this._attempt = attempt;
    this._recorder?.dispose();
    this._recorder = new this.RecorderClass({ ...this.recorderOptions, scope: this.scope,
      maxBytes: Math.min(2 * 1024 * 1024, Number(this._server.maxBytes) || 2 * 1024 * 1024),
      // Leave headroom for the last encoded frame and timer scheduling before the server limit.
      maxDurationMs: Math.max(1000, Math.min(24000, (Number(this._server.maxDurationSeconds) || 25) * 1000 - 1000)),
      ...(Array.isArray(this._server.mimeTypes) ? { mimeTypes: this._server.mimeTypes } : {}),
      onState: value => { if (this._attempt === attempt && !this._disposed) this._state(value); },
      onHint: hint => {
        if (this._attempt !== attempt || this._disposed) return;
        this.onHint(fallback && this.state === 'listening' ? '浏览器识别未返回文字，已切换服务器识别。请再说一遍英语，说完点击麦克风结束。' : hint);
      },
      onError: error => {
        if (this._attempt !== attempt || this._disposed) return;
        this._attempt = null; this._state('idle'); this._error(error.code, error.detail);
      },
      onAudio: audio => { void this._transcribe(attempt, audio); }
    });
    const started = await this._recorder.start();
    if (!started && this._attempt === attempt) { this._attempt = null; this._state('idle'); }
    return started;
  }

  async _transcribe(attempt, audio) {
    if (this._disposed || this._attempt !== attempt) return;
    this._state('processing'); this.onHint('收音结束，正在通过服务器识别英语…');
    attempt.controller = new AbortController();
    try {
      const response = await this._request('/api/speech/transcribe', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': audio.type || 'application/octet-stream', 'X-Requested-With': 'ybtc' }, body: audio
      }, this.uploadTimeoutMs, attempt.controller);
      const data = response.data;
      if (this._disposed || this._attempt !== attempt) return;
      if (!response.ok) {
        const providerCode = Object.prototype.hasOwnProperty.call(SERVER_ERRORS, data.code) ? data.code : '';
        const code = SERVER_ERRORS[providerCode] || (response.status === 401 ? 'login-required' : response.status === 429 ? 'rate-limited' : response.status === 503 ? 'stt-unavailable' : 'upload-failed');
        throw Object.assign(new Error(), { code, status: response.status, providerCode });
      }
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) throw Object.assign(new Error(), { code: 'no-speech' });
      this._attempt = null; this._state('idle');
      this.onTranscript({ text, confidence: Number.isFinite(data.confidence) && data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null });
    } catch (error) {
      if (this._disposed || this._attempt !== attempt) return;
      this._attempt = null; this._state('idle');
      this._error(error.code || (error.name === 'TimeoutError' ? 'upload-timeout' : error.name === 'AbortError' ? 'aborted' : 'upload-failed'), error.status ? `HTTP ${error.status}${error.providerCode ? ` ${error.providerCode}` : ''}` : '');
    } finally { audio = null; attempt.controller = null; }
  }

  async stop() {
    if (this._disposed || !this._attempt) return false;
    return this._attempt.path === 'browser' ? this._browser.stop() : this._recorder.stop();
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true; this._capabilityController?.abort(); this._attempt?.controller?.abort(); this._attempt = null;
    this._recorder?.dispose(); await this._browser.dispose();
    this.scope.removeEventListener?.('pagehide', this._pagehide); this.supported = false; this._state('idle');
  }
}
