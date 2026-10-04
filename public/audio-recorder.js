const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 25000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

export function selectRecordingMimeType(Recorder, accepted = MIME_TYPES) {
  if (typeof Recorder?.isTypeSupported !== 'function') return '';
  return MIME_TYPES.find(type => accepted.some(value => type.split(';')[0] === value.split(';')[0]) && Recorder.isTypeSupported(type)) || '';
}

/** One short utterance in memory. Nothing is persisted, played back, or uploaded here. */
export class MemoryAudioRecorder {
  constructor({ scope = globalThis, onState = () => {}, onHint = () => {}, onAudio = () => {}, onError = () => {},
    maxBytes = MAX_BYTES, maxDurationMs = MAX_DURATION_MS, mimeTypes = MIME_TYPES, permissionTimeoutMs = 15000,
    stopTimeoutMs = 4000, silenceMs = 1300, now = () => performance.now() } = {}) {
    this.scope = scope; this.onState = onState; this.onHint = onHint; this.onAudio = onAudio; this.onError = onError;
    this.maxBytes = Math.min(MAX_BYTES, maxBytes); this.maxDurationMs = Math.min(MAX_DURATION_MS, maxDurationMs);
    this.mimeTypes = mimeTypes; this.permissionTimeoutMs = permissionTimeoutMs; this.stopTimeoutMs = stopTimeoutMs;
    this.silenceMs = silenceMs; this.now = now; this.state = 'idle'; this._run = null; this._disposed = false;
  }

  get supported() { return this.scope.isSecureContext === true && typeof this.scope.navigator?.mediaDevices?.getUserMedia === 'function' && typeof this.scope.MediaRecorder === 'function'; }
  _state(value) { this.state = value; this.onState(value); }
  _alive(run) { return !this._disposed && this._run === run; }
  _stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }

  _release(run) {
    clearTimeout(run.permissionTimer); clearTimeout(run.limitTimer); clearTimeout(run.stopTimer); clearInterval(run.silenceTimer);
    run.cancelPermission?.(); run.cancelPermission = null;
    if (run.recorder) {
      run.recorder.ondataavailable = null; run.recorder.onstop = null; run.recorder.onerror = null;
      if (run.recorder.state !== 'inactive') { try { run.recorder.stop(); } catch { /* Already stopped by the device. */ } }
    }
    this._stopTracks(run.stream); run.stream = null; run.chunks.length = 0;
    try { run.source?.disconnect(); } catch { /* Optional silence detector. */ }
    try { Promise.resolve(run.context?.close()).catch(() => {}); } catch { /* Context already closed. */ }
    run.context = null; run.source = null; run.recorder = null;
  }

  _fail(run, code, detail = '') {
    if (!this._alive(run)) return;
    this._run = null; this._release(run); this._state('idle'); this.onError({ code, detail });
  }

  _monitorSilence(run) {
    if (!run.context || run.context.state === 'suspended') return;
    try {
      const analyser = run.context.createAnalyser(); analyser.fftSize = 2048;
      run.source = run.context.createMediaStreamSource(run.stream); run.source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let voicedMs = 0, lastVoice = this.now(), previous = this.now();
      run.silenceTimer = setInterval(() => {
        if (!this._alive(run) || run.stopping) return;
        const at = this.now(); analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        if (rms > 0.015) { voicedMs += Math.min(150, at - previous); lastVoice = at; }
        previous = at;
        if (voicedMs >= 300 && at - run.started >= 1600 && at - lastVoice >= this.silenceMs) this.stop();
      }, 100);
    } catch { /* Manual stop and the duration limit remain available. */ }
  }

  async start() {
    if (this._disposed || this._run) return false;
    if (!this.supported) { this.onError({ code: this.scope.isSecureContext ? 'recorder-unsupported' : 'insecure-context' }); return false; }
    const run = { chunks: [], bytes: 0, stream: null, recorder: null, stopping: false, started: 0 };
    this._run = run; this._state('checking'); this.onHint('正在打开麦克风，请允许录音权限。');
    try {
      const Audio = this.scope.AudioContext || this.scope.webkitAudioContext;
      if (Audio) {
        try { run.context = new Audio(); Promise.resolve(run.context.resume()).catch(() => {}); } catch { /* Silence stop is optional. */ }
      }
      const waiting = this.scope.navigator.mediaDevices.getUserMedia({ audio: true });
      // A permission prompt can resolve after timeout, navigation or disposal.
      Promise.resolve(waiting).then(stream => { if (!this._alive(run)) this._stopTracks(stream); }, () => {});
      const cancelled = new Promise((_, reject) => {
        run.cancelPermission = () => reject(Object.assign(new Error(), { name: 'AbortError' }));
        run.permissionTimer = setTimeout(() => reject(Object.assign(new Error(), { name: 'PermissionTimeoutError' })), this.permissionTimeoutMs);
      });
      run.stream = await Promise.race([waiting, cancelled]);
      clearTimeout(run.permissionTimer); run.cancelPermission = null;
      if (!this._alive(run)) { this._stopTracks(run.stream); return false; }
      const tracks = run.stream.getAudioTracks();
      if (!tracks.some(track => track.readyState === 'live' && track.enabled)) { this._fail(run, 'audio-capture'); return false; }
      const mimeType = selectRecordingMimeType(this.scope.MediaRecorder, this.mimeTypes);
      run.recorder = new this.scope.MediaRecorder(run.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
      run.recorder.ondataavailable = event => {
        if (!this._alive(run) || !event.data?.size) return;
        run.bytes += event.data.size;
        if (run.bytes > this.maxBytes) { this._fail(run, 'audio-too-large'); return; }
        run.chunks.push(event.data);
      };
      run.recorder.onerror = event => this._fail(run, event.error?.name || 'recording-failed');
      run.recorder.onstop = () => {
        if (!this._alive(run)) return;
        const type = run.recorder.mimeType || run.chunks[0]?.type || mimeType;
        let audio = new Blob(run.chunks, { type });
        if (!audio.size) { this._fail(run, 'empty-audio'); return; }
        const durationMs = Math.max(0, this.now() - run.started);
        this._run = null; this._release(run); this._state('processing');
        this.onAudio(audio, { durationMs }); audio = null;
      };
      run.recorder.start(250); run.started = this.now();
      this._state('listening'); this.onHint('正在录音，请说英语；说完再次点击麦克风，或稍停片刻自动结束。');
      run.limitTimer = setTimeout(() => this.stop(), this.maxDurationMs); this._monitorSilence(run);
      return true;
    } catch (error) {
      if (!this._alive(run)) return false;
      const codes = { NotAllowedError: 'not-allowed', SecurityError: 'not-allowed', NotFoundError: 'audio-capture', NotReadableError: 'audio-capture', PermissionTimeoutError: 'permission-timeout', AbortError: 'aborted' };
      this._fail(run, codes[error.name] || 'recording-failed', error.name || ''); return false;
    }
  }

  stop() {
    const run = this._run;
    if (!run || this._disposed || run.stopping) return false;
    if (!run.recorder) { this._fail(run, 'aborted'); return true; }
    run.stopping = true; clearTimeout(run.limitTimer); clearInterval(run.silenceTimer); this._state('processing');
    this.onHint('收音结束，正在识别英语…');
    run.stopTimer = setTimeout(() => this._fail(run, 'recording-stop-timeout'), this.stopTimeoutMs);
    try { run.recorder.stop(); this._stopTracks(run.stream); return true; }
    catch (error) { this._fail(run, 'recording-failed', error.name || ''); return false; }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const run = this._run; this._run = null;
    if (run) this._release(run);
    this._state('idle');
  }
}
