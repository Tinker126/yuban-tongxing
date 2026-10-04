import { api, element } from './common.js';
import { ReliableSpeech } from './reliable-speech.js';
import { checkMicrophone } from './microphone-check.js';
import { detectWebSpeechSupport } from './web-speech-support.js';
const $ = id => document.getElementById(id);
let topics, session = null, history = [], turns = [], busy = false, listening = false, testingMic = false, speaking = false;
let saved = false, lastReply = '', pendingInput = null, speechVersion = 0, micCheckController, cancelTts;
let practiceMode = 'free', scenarioList = [], selectedScenario = null, scenarioProgress = {}, scenarioTaskComplete = false;
let practiceSaveQueue = Promise.resolve();
const pendingPracticeTurns = new Map();
const welcomeTemplate = $('chat').firstElementChild.cloneNode(true);
const SCENE_ICONS = { friends:'👋', school:'🏫', restaurant:'🍔', shopping:'🛍️', directions:'🗺️', birthday:'🎂' };
const speechCapabilities = detectWebSpeechSupport(window);
const Recognition = speechCapabilities.Recognition;
console.log('[Speech capabilities]', {
  SpeechRecognition: speechCapabilities.standardRecognition,
  webkitSpeechRecognition: speechCapabilities.prefixedRecognition,
  getUserMedia: speechCapabilities.getUserMedia,
  MediaRecorder: !!window.MediaRecorder,
  speechSynthesis: speechCapabilities.speechSynthesis,
  secureContext: speechCapabilities.secureContext
});
Object.assign($('phase').dataset, {
  speechRecognition: typeof window.SpeechRecognition,
  webkitSpeechRecognition: typeof window.webkitSpeechRecognition,
  mediaDevices: String(!!navigator.mediaDevices),
  getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
  mediaRecorder: String(!!window.MediaRecorder),
  speechSynthesis: String(speechCapabilities.speechSynthesis),
  secureContext: String(speechCapabilities.secureContext)
});
function notice(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function avatar(state, label) { $('buddy').dataset.state = state; $('buddy').setAttribute('aria-label', label); $('buddy-label').textContent = label; }
function phase(state) {
  const labels = { idle:'准备好啦，可以继续说英语', listening:'正在倾听', processing:'正在识别', thinking:'正在思考', speaking:'正在朗读' };
  $('phase').textContent = `${labels[state]} · ${state}`;
  $('phase').dataset.state = state;
}
function controls() {
  const sttActive = ['checking','listening','processing'].includes(speech.state);
  const frozen = busy || sttActive || testingMic || speaking;
  $('start').disabled = !topics || !$('consent').checked || busy || (practiceMode === 'scenario' && !selectedScenario);
  $('start').textContent = practiceMode === 'scenario' ? '开始情景练习 →' : '开始今天的练习 →';
  $('grade').disabled = !!session || busy;
  $('topic').disabled = !topics || !!session || busy || practiceMode !== 'free';
  $('mode-free').disabled = !!session || busy;
  $('mode-scenario').disabled = !!session || busy;
  $('mic').disabled = busy || speaking || testingMic || ['checking','processing'].includes(speech.state) || !speech.supported || history.length >= 30 || saved || scenarioTaskComplete;
  $('check-speech').disabled = frozen || saved;
  $('test-mic').disabled = busy || speaking || sttActive || saved;
  $('test-mic').textContent = testingMic ? '停止检测' : '检测麦克风';
  $('send').disabled = frozen || history.length >= 30 || saved || scenarioTaskComplete;
  $('text-input').disabled = frozen || saved || scenarioTaskComplete;
  $('finish').disabled = frozen || history.length === 0 || saved;
  $('replay').disabled = frozen || !lastReply;
  $('round-count').textContent = `${history.length} / 30 轮`;
  $('mic-label').textContent = listening ? '正在听你说英语…' : speech.state === 'processing' ? '正在识别…' : '点击说英语';
  $('mic').title = listening ? '说完后点击停止收音' : '点击开始说英语';
  $('mic').setAttribute('aria-label', listening ? '停止英语语音识别' : '开始英语语音识别');
  $('mic').classList.toggle('listening', listening);
}
function addMessage(who, content, comment) {
  const message = element('div', undefined, `message ${who}`);
  message.append(element('p', who === 'student' ? '我 · ME' : '小伴 · BUDDY', 'speaker'), element('p', content, 'bubble'));
  if (comment) {
    const feedback = element('div', undefined, 'feedback');
    feedback.append(element('p', `✦ 表达亮点：${comment.highlight}`), element('p', `↗ 试试这样：${comment.suggestion}`));
    message.append(feedback);
  }
  $('chat').append(message); $('chat').scrollTop = $('chat').scrollHeight;
}
function stopSpeaking() {
  speechVersion++; cancelTts?.(); cancelTts = null;
  window.speechSynthesis?.cancel?.(); speaking = false;
  avatar('idle', '小伴在这里陪你');
  if (!busy && speech.state === 'idle') phase('idle');
  controls();
}
async function speak(value) {
  if (speech.state !== 'idle') return false;
  stopSpeaking();
  speaking = true; controls(); phase('speaking');
  const version = speechVersion;
  const hint = $('tts-help'); hint.hidden = false;
  const unlock = () => { if (version === speechVersion) { speaking = false; phase('idle'); avatar('idle', '轮到你啦，慢慢说'); controls(); } };
  if (!speechCapabilities.speechSynthesis) {
    hint.textContent = '朗读：此浏览器不支持语音播放，请在系统浏览器使用最新版 Chrome 或 Edge。你也可以阅读小伴的回答。';
    unlock(); return false;
  }
  const synthesis = speechCapabilities.synthesis;
  const findVoice = () => {
    let voices = [];
    try { voices = typeof synthesis.getVoices === 'function' ? synthesis.getVoices() : []; } catch { /* Use the browser default voice. */ }
    const english = voices.filter(v => /^en(?:[-_]|$)/i.test(v.lang));
    return english.find(v => /^en[-_]US$/i.test(v.lang)) || english[0];
  };
  let voice = findVoice();
  if (version !== speechVersion) return false;
  voice = findVoice();
  hint.textContent = voice ? `朗读：使用 ${voice.name}。` : '朗读：尝试浏览器默认英语声音。';
  let utterance;
  try { utterance = new speechCapabilities.Utterance(value); }
  catch (error) { hint.textContent = `朗读：浏览器无法创建语音，请使用最新版 Chrome 或 Edge（${error.name || 'unsupported'}）。`; unlock(); return false; }
  if (voice) utterance.voice = voice;
  utterance.lang = 'en-US'; utterance.rate = 0.82;
  return new Promise(resolve => {
    let settled = false, timer, startTimer;
    const finish = (ok, error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(startTimer);
      if (version === speechVersion) {
        cancelTts = null;
        if (['not-allowed', 'autoplay-blocked'].includes(error)) hint.textContent = '浏览器尚未播放语音，请点击“再听一遍”后播放；也可以继续说英语。';
        else if (error) hint.textContent = `朗读失败（${error}），可以重试“再听一遍”。`;
        else if (ok) hint.textContent = '朗读已结束，可以继续说英语。';
        unlock();
      }
      resolve(ok);
    };
    cancelTts = () => finish(false, 'canceled');
    utterance.onstart = () => { clearTimeout(startTimer); if (version === speechVersion) { hint.textContent = '正在朗读英语…'; avatar('speaking', '小伴正在说英语'); } };
    utterance.onend = () => finish(true);
    utterance.onerror = e => finish(false, e.error || 'unknown');
    timer = setTimeout(() => { finish(false, 'tts-timeout'); synthesis.cancel?.(); }, 45000);
    startTimer = setTimeout(() => { finish(false, 'autoplay-blocked'); synthesis.cancel?.(); }, 4000);
    try { synthesis.speak(utterance); }
    catch (e) { finish(false, e.name || 'tts-start-failed'); }
  });
}
function updateTopic() {
  $('topic').replaceChildren(...topics[$('grade').value].map(t => { const option = element('option', t); option.value = t; return option; }));
}
function setPracticeMode(mode) {
  practiceMode = mode;
  const scenario = mode === 'scenario';
  $('mode-free').classList.toggle('active', !scenario); $('mode-free').setAttribute('aria-pressed', String(!scenario));
  $('mode-scenario').classList.toggle('active', scenario); $('mode-scenario').setAttribute('aria-pressed', String(scenario));
  $('free-topic-fields').hidden = scenario; $('scenario-picker').hidden = !scenario;
  if (scenario) void loadScenarios();
  controls();
}
function renderScenarioChoices() {
  const grid = $('scenario-grid'); grid.replaceChildren();
  for (const scene of scenarioList) {
    const button = element('button', undefined, 'scenario-card'); button.type = 'button';
    button.setAttribute('aria-pressed', String(selectedScenario?.id === scene.id));
    button.append(element('span', SCENE_ICONS[scene.category] || '💬', 'scenario-icon'), document.createTextNode(scene.title));
    button.addEventListener('click', () => { selectedScenario = scene; renderScenarioChoices(); renderScenarioDetail(); controls(); });
    grid.append(button);
  }
  if (!scenarioList.length) grid.append(element('p', '情景暂时没有加载成功，请稍后重试。', 'mini'));
}
function renderScenarioDetail() {
  const detail = $('scenario-detail');
  detail.hidden = !selectedScenario;
  if (!selectedScenario) return;
  $('scenario-title').textContent = selectedScenario.title;
  $('scenario-student-role').textContent = selectedScenario.studentRole;
  $('scenario-ai-role').textContent = selectedScenario.aiRole;
  $('scenario-objective').textContent = `今日任务：${selectedScenario.objective}`;
  $('scenario-difficulty').textContent = `${selectedScenario.grade}年级 · ${selectedScenario.difficulty} · ${selectedScenario.replyGuidance}`;
  $('scenario-expressions').replaceChildren(...selectedScenario.targetExpressions.map(expression => element('li', expression)));
}
async function loadScenarios() {
  try {
    const oldId = selectedScenario?.id;
    const data = await api(`/api/scenarios?grade=${encodeURIComponent($('grade').value)}`);
    scenarioList = data.scenes;
    selectedScenario = scenarioList.find(scene => scene.id === oldId) || null;
    renderScenarioChoices(); renderScenarioDetail(); controls();
  } catch (error) { notice(`情景加载失败：${error.message}`, true); }
}
function renderScenarioProgress(progress = scenarioProgress) {
  if (!session?.scenario) { $('scenario-progress').hidden = true; return; }
  scenarioProgress = progress || {};
  $('scenario-progress').hidden = false;
  $('scenario-name').hidden = false; $('scenario-name').textContent = `${SCENE_ICONS[session.scenario.category] || '💬'} ${session.scenario.title}`;
  const list = $('scenario-progress-items'); list.replaceChildren();
  for (const condition of session.scenario.completionConditions) {
    const done = scenarioProgress[condition.id] === true;
    const item = element('li', `${done ? '✓' : '○'} ${condition.label}`, done ? 'done' : '');
    list.append(item);
  }
  scenarioTaskComplete = session.scenario.completionConditions.every(condition => scenarioProgress[condition.id] === true);
  $('scenario-progress-status').textContent = scenarioTaskComplete ? '任务完成！请结束并保存查看本次结果。' : '一步一步完成今天的小任务';
  $('scenario-progress-heading').textContent = scenarioTaskComplete ? '任务完成！' : '情景任务';
  controls();
}
function resetScenarioPractice(clearSelection = false) {
  session = null; history = []; turns = []; saved = false; lastReply = ''; pendingInput = null;
  pendingPracticeTurns.clear(); practiceSaveQueue = Promise.resolve(); scenarioProgress = {}; scenarioTaskComplete = false;
  $('chat').replaceChildren(welcomeTemplate.cloneNode(true)); $('intro').hidden = false; $('active-controls').hidden = true;
  $('conversation-card').classList.remove('scenario-finished');
  $('scenario-result').hidden = true; $('restart').hidden = true; $('scenario-progress').hidden = true; $('scenario-name').hidden = true;
  if (clearSelection) selectedScenario = null;
  setPracticeMode('scenario'); renderScenarioChoices(); renderScenarioDetail();
  notice('选好情景后，就可以再开始一次练习。'); avatar('idle', '小伴准备好啦'); controls();
}
async function savePracticeTurn(turn) {
  try {
    await api(`/api/practice/sessions/${session.practiceSessionId}/turns`, { turnNumber: turn.turnNumber, receipt: turn.receipt }, 12000);
    pendingPracticeTurns.delete(turn.turnNumber);
    return true;
  } catch (error) {
    pendingPracticeTurns.set(turn.turnNumber, turn);
    console.error('[practice turn save]', error.status || 'network', error.message);
    notice('本轮学习记录暂未保存；练习可以继续，结束时会重试。');
    return false;
  }
}
function queuePracticeTurn(turn) {
  pendingPracticeTurns.set(turn.turnNumber, turn);
  practiceSaveQueue = practiceSaveQueue.then(() => savePracticeTurn(turn));
}
async function retryPendingPracticeTurns() {
  await practiceSaveQueue;
  for (const turn of [...pendingPracticeTurns.values()].sort((a, b) => a.turnNumber - b.turnNumber)) {
    await savePracticeTurn(turn);
  }
  if (pendingPracticeTurns.size) throw new Error('仍有学习记录未能保存，请保持页面打开后重试。');
}
const speech = new ReliableSpeech({
  Recognition, secure: window.isSecureContext && location.protocol !== 'file:',
  onState(state) {
    if (state === 'checking') { delete $('speech-help').dataset.errorCode; delete $('speech-help').dataset.errorSource; }
    listening = state === 'listening';
    if (listening) { avatar('listening', '小伴正在认真听'); phase('listening'); }
    else if (state === 'processing' || state === 'checking') phase('processing');
    else if (!busy && !speaking) { avatar('idle', '小伴在这里陪你'); phase('idle'); }
    controls();
  },
  onHint(message) { $('speech-help').textContent = `语音输入：${message}`; },
  onError({ code, message, detail, source, recoverable }) {
    if ((recoverable || code === 'aborted') && source !== 'server-stt') {
      $('speech-help').textContent = `语音输入：${message}（可重试）`;
      delete $('speech-help').dataset.errorSource; delete $('speech-help').dataset.errorCode;
      if (!busy && !speaking) phase('idle');
      return;
    }
    $('speech-help').textContent = `语音输入：${message}（${code}）${detail ? ` ${detail}` : ''}`;
    $('speech-help').dataset.errorSource = source;
    $('speech-help').dataset.errorCode = code;
    console.error('[speech]', source, code, detail || '');
    if (!busy && !speaking) phase('idle');
  },
  onTranscript({text, confidence}) { $('text-input').value = text; void sendText(text, 'speech', confidence); }
});
async function sendText(value, inputMode = 'text', confidence = null) {
  value = value.trim();
  if (!value || !session || busy || saved || scenarioTaskComplete || history.length >= 30) return;
  if (value.length > 600) { notice('这一句有点长，请控制在600个字符内。', true); return; }
  stopSpeaking(); busy = true; controls(); phase('thinking'); notice('小伴正在想怎么回答你…'); avatar('idle', '小伴正在想一想');
  pendingInput = { text: value, inputMode, confidence };
  try {
    const chatRoute = session.scenario ? '/api/scenarios/chat' : '/api/chat';
    const result = await api(chatRoute, { ...pendingInput, sessionToken: session.sessionToken, history,
      grade: Number($('grade').value), topic: session.scenario ? session.scenario.title : $('topic').value });
    history.push(result.receipt);
    turns.push({ student: value, reply: result.reply, comment: result.comment, confidence, inputMode, time: result.time, progress: result.progress });
    addMessage('student', value); addMessage('assistant', result.reply, result.comment);
    queuePracticeTurn({ turnNumber: turns.length, receipt: result.receipt });
    if (session.scenario) renderScenarioProgress(result.progress);
    $('text-input').value = ''; pendingInput = null; lastReply = result.reply;
    notice(result.completed ? '任务完成！请点击“结束并保存”，查看本次学习结果。' : history.length >= 30 ? '你已经完成30轮啦！请点击“结束并保存”。' : '说得很棒，继续试试吧。');
    await speak(result.reply);
  } catch (e) {
    $('text-input').value = value;
    notice(`${e.message} 这句话已保留在输入框，点击发送可重试。`, true);
    avatar('idle', '小伴在这里等你');
  } finally { busy = false; if (!speaking && speech.state === 'idle') phase('idle'); controls(); }
}
$('grade').addEventListener('change', () => { updateTopic(); if (practiceMode === 'scenario') void loadScenarios(); });
$('consent').addEventListener('change', controls);
function showScenarioResult(result) {
  const summary = result.scenario;
  const duration = Number(result.durationSeconds) || 0;
  const minutes = Math.floor(duration / 60), seconds = duration % 60;
  $('scenario-result-title').textContent = summary?.completed ? '任务完成！' : '练习已保存！';
  $('scenario-result-summary').textContent = `完成${result.turnCount}轮 · 练习${minutes}分${String(seconds).padStart(2, '0')}秒 · ${session.scenario.title}`;
  const tasks = $('scenario-result-tasks'); tasks.replaceChildren();
  for (const condition of summary?.completedConditions || []) tasks.append(element('li', condition.label));
  if (!tasks.childNodes.length) tasks.append(element('li', '本次练习已保存，可以继续挑战这些任务。'));
  const used = $('scenario-result-used'); used.replaceChildren();
  for (const expression of summary?.usedExpressions || []) used.append(element('li', expression));
  if (!used.childNodes.length) used.append(element('li', '本次对话还没有完整使用推荐表达。'));
  const usedSet = new Set(summary?.usedExpressions || []);
  $('scenario-result-targets').replaceChildren(...(summary?.targetExpressions || session.scenario.targetExpressions)
    .filter(expression => !usedSet.has(expression)).map(expression => element('li', expression)));
  $('scenario-result').hidden = false;
  $('conversation-card').classList.add('scenario-finished');
}
async function startPractice() {
  busy = true; controls();
  try {
    const grade = Number($('grade').value), isScenario = practiceMode === 'scenario';
    const topic = isScenario ? selectedScenario.title : $('topic').value;
    const practice = await api('/api/practice/sessions', { grade, topic, consent: $('consent').checked,
      ...(isScenario ? { sceneId: selectedScenario.id } : {}) });
    session = isScenario
      ? await api(`/api/scenarios/${encodeURIComponent(selectedScenario.id)}/start`, { practiceSessionId: practice.sessionId })
      : await api('/api/startSession', { grade, topic, consent: $('consent').checked, practiceSessionId: practice.sessionId });
    session.practiceSessionId = practice.sessionId;
    if (isScenario) { session.scenario = selectedScenario; renderScenarioProgress(session.progress); }
    $('chat').replaceChildren(); $('intro').hidden = true; $('active-controls').hidden = false;
    lastReply = session.opening; addMessage('assistant', lastReply);
    notice(isScenario ? `你是${selectedScenario.studentRole}，小伴是${selectedScenario.aiRole}。试着完成今天的情景任务吧。` : '用一句英语回答小伴吧。');
    await speech.check(); await speak(lastReply);
  } catch (e) { notice(e.message, true); }
  finally { busy = false; controls(); }
}
$('mode-free').addEventListener('click', () => setPracticeMode('free'));
$('mode-scenario').addEventListener('click', () => setPracticeMode('scenario'));
$('start').addEventListener('click', () => void startPractice());
$('mic').addEventListener('click', async () => {
  if (listening) { speech.stop(); return; }
  if (busy || speaking || testingMic || speech.state !== 'idle') return;
  stopSpeaking();
  await speech.start();
  controls();
});
$('check-speech').addEventListener('click', async () => { await speech.check(); controls(); });
$('test-mic').addEventListener('click', async () => {
  if (testingMic) { micCheckController?.abort(); return; }
  stopSpeaking(); testingMic = true; micCheckController = new AbortController(); controls();
  const message = $('mic-diagnostic'); message.hidden = false;
  message.textContent = '请允许麦克风，并说一句 Hello, how are you? 检测只在设备内进行，不会录音或上传。';
  $('mic-meter').hidden = false;
  const timeout = setTimeout(() => micCheckController.abort(), 30000);
  try {
    const result = await checkMicrophone({ signal: micCheckController.signal, onLevel: level => { $('mic-meter').value = level; } });
    message.textContent = result.soundDetected ? `麦克风已收到声音（${result.device}）。请点击“说英语”；如果仍无文字，查看上方的识别错误提示。` : `麦克风没有收到明显声音（${result.device}）。请检查是否静音、系统默认输入设备是否正确，再检测一次。`;
  } catch (e) {
    message.textContent = e.name === 'AbortError' ? '麦克风检测已停止。' : `${e.message}（${e.code || e.name}）${e.detail ? ` ${e.detail}` : ''}`;
    console.error('[Microphone check]', e.code || e.name, e.detail || e.message);
  }
  finally { clearTimeout(timeout); testingMic = false; $('mic-meter').hidden = true; controls(); }
});
$('text-input').addEventListener('input', () => { pendingInput = null; });
$('text-form').addEventListener('submit', event => {
  event.preventDefault(); if (listening) return;
  const value = $('text-input').value;
  const retry = pendingInput && pendingInput.text === value.trim() ? pendingInput : null;
  void sendText(value, retry?.inputMode || 'text', retry?.confidence ?? null);
});
$('replay').addEventListener('click', () => { if (!busy && !speaking && !testingMic && speech.state === 'idle') void speak(lastReply); });
$('finish').addEventListener('click', async () => {
  busy = true; controls(); stopSpeaking(); notice('正在保存本次练习，请不要关闭页面…');
  try {
    await retryPendingPracticeTurns();
    const result = await api(`/api/practice/sessions/${session.practiceSessionId}/complete`, {}, 55000, 'PATCH');
    saved = true; $('active-controls').hidden = true;
    if (session.scenario) { showScenarioResult(result); $('restart').hidden = true; }
    else $('restart').hidden = false;
    notice(`练习已保存！今天勇敢开口了${history.length}轮，下次见。`); avatar('idle', '今天的你，很棒！');
  } catch (e) { notice(`${e.message} 数据仍保留在当前页面，请不要关闭，稍后再点“结束并保存”。`, true); }
  finally { busy = false; controls(); }
});
$('scenario-again').addEventListener('click', () => { resetScenarioPractice(false); void startPractice(); });
$('scenario-change').addEventListener('click', () => resetScenarioPractice(true));
$('restart').addEventListener('click', () => location.reload());
window.addEventListener('beforeunload', event => { if (session && !saved && (history.length || busy || listening || pendingInput)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { speech.dispose(); micCheckController?.abort(); stopSpeaking(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (listening) speech.stop(); micCheckController?.abort(); stopSpeaking(); } });
try { const result = await api('/api/topics'); topics = result.topics; updateTopic(); }
catch (e) { notice(`话题加载失败：${e.message} 请刷新页面。`, true); }
try { window.speechSynthesis?.getVoices?.(); } catch { /* Voice discovery must not block practice. */ }
controls();
phase('idle');
