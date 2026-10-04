import { MemoryAudioRecorder } from './audio-recorder.js';

const $ = id => document.getElementById(id);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const report = {
  protocol: location.protocol, isSecureContext: window.isSecureContext,
  getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
  microphonePermission: 'unknown', audioStreamObtained: null, audioTracks: [],
  MediaRecorder: typeof window.MediaRecorder === 'function',
  SpeechRecognition: typeof window.SpeechRecognition === 'function',
  webkitSpeechRecognition: typeof window.webkitSpeechRecognition === 'function',
  recording: null
};
let active = null, recorder = null, micRun = null, recognitionSummary = null;
const events = [];
function log(name, data = {}) {
  const entry = { time: new Date().toISOString(), event: name, ...data };
  events.push(entry);
  $('events').textContent += JSON.stringify(entry) + '\n';
}
function render() {
  $('capabilities').textContent = JSON.stringify(report, null, 2);
  const busy = !!(active || recorder || micRun);
  for (const id of ['test-mic', 'test-recorder', 'start']) $(id).disabled = busy;
  $('stop').disabled = !active || active.stopping;
  if (!busy) $('state').textContent = 'idle';
  $('recognition-summary').textContent = recognitionSummary ? JSON.stringify(recognitionSummary, null, 2) : '尚未测试';
}
async function permission() {
  try { report.microphonePermission = (await navigator.permissions.query({ name: 'microphone' })).state; }
  catch { report.microphonePermission = 'unknown（浏览器未提供权限查询）'; }
  render();
}
function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); }

$('test-mic').addEventListener('click', async () => {
  if (active || recorder || micRun) return;
  if (!report.getUserMedia) { log('getUserMedia unavailable'); return; }
  const run = { stream: null }; micRun = run; render();
  $('state').textContent = '请允许麦克风权限';
  let timer;
  try {
    await permission();
    const pending = navigator.mediaDevices.getUserMedia({ audio: true });
    pending.then(stream => { if (micRun !== run) stopTracks(stream); }, () => {});
    run.stream = await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(), { name: 'PermissionTimeout' })), 15000);
    })]);
    if (micRun !== run) { stopTracks(run.stream); return; }
    report.audioStreamObtained = true;
    report.audioTracks = run.stream.getAudioTracks().map(track => ({ readyState: track.readyState, enabled: track.enabled, muted: track.muted }));
    log('getUserMedia success', { audioTracks: report.audioTracks });
  } catch (error) {
    report.audioStreamObtained = false; report.audioTracks = [];
    log('getUserMedia error', { code: error.name });
  } finally {
    clearTimeout(timer); stopTracks(run.stream); if (micRun === run) micRun = null;
    await permission(); render();
  }
});

$('test-recorder').addEventListener('click', async () => {
  if (active || recorder || micRun) return;
  report.recording = null;
  const instance = new MemoryAudioRecorder({ maxDurationMs: 3000, silenceMs: 6000,
    onState(state) { $('state').textContent = state === 'listening' ? '正在录音 3 秒，请说英语' : state; },
    onHint(message) { log('recorder', { message }); },
    onError(error) { log('MediaRecorder error', { code: error.code }); recorder = null; render(); void permission(); },
    onAudio(blob, metadata) {
      report.recording = { requestedDurationMs: 3000, durationMs: Math.round(metadata.durationMs), blobSize: blob.size, nonEmpty: blob.size > 0, mimeType: blob.type };
      log('MediaRecorder complete', report.recording);
      // Only metadata remains. No object URL, playback, storage, or network upload.
      recorder = null; blob = null; instance.dispose(); render(); void permission();
    }
  });
  recorder = instance; render(); await instance.start();
});

const eventNames = ['onstart', 'onaudiostart', 'onsoundstart', 'onspeechstart', 'onresult', 'onerror', 'onspeechend', 'onsoundend', 'onaudioend', 'onend'];
function finish(run) {
  if (active !== run) return;
  clearTimeout(run.watchdog); clearTimeout(run.abortTimer); active = null; render();
}
$('start').addEventListener('click', () => {
  if (active || recorder || micRun) return;
  if (typeof Recognition !== 'function') { log('SpeechRecognition unavailable'); return; }
  const run = { recognition: null, startedAt: performance.now(), stopping: false };
  active = run;
  recognitionSummary = { resultFired: false, audioStart: false, speechStart: false, error: null, ended: false, startToEndMs: null, events: [] };
  render(); $('state').textContent = '正在启动普通英语识别，请说英语';
  try {
    const r = new Recognition(); run.recognition = r;
    r.lang = 'en-US'; r.interimResults = false; r.continuous = false;
    for (const name of eventNames) r[name] = event => {
      if (active !== run) return;
      const elapsedMs = Math.round(performance.now() - run.startedAt);
      const detail = { elapsedMs };
      recognitionSummary.events.push(name);
      if (name === 'onstart') $('state').textContent = '识别已开始，请说英语';
      if (name === 'onaudiostart') recognitionSummary.audioStart = true;
      if (name === 'onspeechstart') recognitionSummary.speechStart = true;
      // Do not read event.results or any recognized student text.
      if (name === 'onresult') recognitionSummary.resultFired = true;
      if (name === 'onerror') { detail['error.error'] = event.error || 'unknown'; recognitionSummary.error = detail['error.error']; }
      log(name, detail);
      if (name === 'onend') { recognitionSummary.ended = true; recognitionSummary.startToEndMs = elapsedMs; finish(run); }
      render();
    };
    run.watchdog = setTimeout(() => {
      if (active !== run) return;
      log('diagnostic-timeout', { elapsedMs: Math.round(performance.now() - run.startedAt) });
      run.abortTimer = setTimeout(() => finish(run), 2000);
      try { r.abort(); } catch { finish(run); }
    }, 35000);
    r.start(); log('recognition.start', { returned: true });
  } catch (error) { log('recognition.start exception', { code: error.name }); recognitionSummary.error = error.name; finish(run); }
});
$('stop').addEventListener('click', () => {
  if (!active || active.stopping) return;
  const run = active; run.stopping = true; render();
  try { run.recognition.stop(); log('recognition.stop'); }
  catch (error) { log('recognition.stop exception', { code: error.name }); finish(run); }
});
$('copy-report').addEventListener('click', async () => {
  const text = JSON.stringify({ browser: $('browser-label').value, capabilities: report, recognition: recognitionSummary, events }, null, 2);
  try { await navigator.clipboard.writeText(text); $('copy-report').textContent = '已复制诊断报告'; }
  catch { $('copy-report').textContent = '复制不可用，请选择页面上的文字复制'; }
});
window.addEventListener('pagehide', () => {
  if (micRun) { stopTracks(micRun.stream); micRun = null; }
  recorder?.dispose(); recorder = null;
  if (active) { const run = active; finish(run); try { run.recognition?.abort(); } catch { /* Already stopped. */ } }
});
render(); void permission();
