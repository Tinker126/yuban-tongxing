import { api, element } from './common.js';
import { formatDuration, formatGrade, formatHistoryDate, formatStatus } from './history-format.js';

const listView = document.getElementById('history-list-view');
const detailView = document.getElementById('history-detail-view');
const pageSize = 10;
let offset = 0;
let pageInfo = { total: 0, hasMore: false };

function addField(container, label, value) {
  const wrapper = element('div', undefined, 'history-field');
  wrapper.append(element('dt', label), element('dd', value));
  container.append(wrapper);
}

function showLoginRequired(message) {
  const status = document.getElementById('history-status');
  status.replaceChildren(element('span', message));
  const link = element('a', '学生登录');
  link.href = '/login';
  status.append(document.createTextNode(' '), link, document.createTextNode('后查看自己的练习记录。'));
}

function renderSessions(sessions) {
  const list = document.getElementById('history-items');
  list.replaceChildren();
  for (const session of sessions) {
    const card = element('article', undefined, 'history-card');
    const header = element('div', undefined, 'history-card-heading');
    const title = element('div');
    title.append(element('p', formatHistoryDate(session.startedAt), 'history-date'));
    if (session.sceneTitle) title.append(element('span', '情景练习', 'history-date'));
    title.append(element('h2', session.sceneTitle || session.topic));
    const badge = element('span', formatStatus(session.status), `history-status-badge status-${session.status}`);
    header.append(title, badge);
    const facts = element('dl', undefined, 'history-facts');
    addField(facts, '年级', formatGrade(session.grade));
    addField(facts, '练习时长', formatDuration(session.durationSeconds));
    addField(facts, '对话轮数', `${session.turnCount}轮`);
    const footer = element('div', undefined, 'history-card-footer');
    footer.append(element('span', session.endedAt ? `结束于 ${formatHistoryDate(session.endedAt, true)}` : '本次练习尚未结束', 'mini'));
    const details = element('a', '查看详情 →', 'history-detail-link');
    details.href = `/history/${encodeURIComponent(session.id)}`;
    footer.append(details);
    card.append(header, facts, footer);
    list.append(card);
  }
}

async function loadSessions() {
  const status = document.getElementById('history-status');
  const items = document.getElementById('history-items');
  const empty = document.getElementById('history-empty');
  const pagination = document.getElementById('history-pagination');
  status.textContent = '正在读取记录…';
  items.replaceChildren();
  empty.hidden = true;
  pagination.hidden = true;
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  const grade = document.getElementById('history-grade').value;
  const topic = document.getElementById('history-topic').value;
  const sessionStatus = document.getElementById('history-status-filter').value;
  if (grade) params.set('grade', grade);
  if (topic) params.set('topic', topic);
  if (sessionStatus) params.set('status', sessionStatus);
  try {
    const data = await api(`/api/practice/sessions?${params}`);
    pageInfo = data.pagination;
    renderSessions(data.sessions);
    status.textContent = data.pagination.total ? `共 ${data.pagination.total} 条练习记录` : '';
    if (!data.pagination.total) {
      empty.hidden = false;
      empty.querySelector('h2').textContent = grade || topic || sessionStatus ? '没有符合条件的练习记录' : '还没有练习记录';
    }
    else if (!data.sessions.length) { empty.hidden = false; empty.querySelector('h2').textContent = '这一页没有记录'; }
    pagination.hidden = data.pagination.total <= pageSize;
    document.getElementById('history-prev').disabled = offset === 0;
    document.getElementById('history-next').disabled = !data.pagination.hasMore;
    document.getElementById('history-page-label').textContent = `${offset + 1}–${Math.min(offset + data.sessions.length, data.pagination.total)} / ${data.pagination.total}`;
  } catch (error) {
    if (error.status === 401) showLoginRequired('请登录');
    else status.textContent = error.message || '暂时无法读取练习记录，请稍后重试。';
  }
}

function renderDetail(data) {
  const session = data.session;
  document.getElementById('detail-title').textContent = session.sceneTitle || session.topic || '练习详情';
  const summary = document.getElementById('detail-summary');
  summary.replaceChildren();
  addField(summary, '练习日期', formatHistoryDate(session.startedAt));
  if (session.sceneTitle) addField(summary, '练习类型', '情景练习');
  addField(summary, '年级', formatGrade(session.grade));
  addField(summary, '练习时长', formatDuration(session.durationSeconds));
  addField(summary, '对话轮数', `${session.turnCount}轮`);
  addField(summary, '开始时间', formatHistoryDate(session.startedAt, true));
  addField(summary, '结束时间', formatHistoryDate(session.endedAt, true));
  addField(summary, '状态', formatStatus(session.status));

  const turns = document.getElementById('history-turns');
  turns.replaceChildren();
  const orderedTurns = data.turns.slice().sort((a, b) => a.turnNumber - b.turnNumber);
  for (const turn of orderedTurns) {
    const section = element('section', undefined, 'history-turn');
    section.append(element('p', `第 ${turn.turnNumber} 轮`, 'history-turn-number'));
    const studentMessage = element('article', undefined, 'history-message student');
    studentMessage.append(element('p', '我', 'speaker'), element('p', turn.studentText, 'bubble'));
    const buddyMessage = element('article', undefined, 'history-message buddy');
    buddyMessage.append(element('p', '小伙伴', 'speaker'), element('p', turn.aiReply, 'bubble'));
    if (turn.feedback && typeof turn.feedback === 'object') {
      const feedback = element('div', undefined, 'feedback history-feedback');
      if (turn.feedback.highlight) feedback.append(element('p', `表达亮点：${turn.feedback.highlight}`));
      if (turn.feedback.suggestion) feedback.append(element('p', `试试这样：${turn.feedback.suggestion}`));
      if (feedback.childNodes.length) buddyMessage.append(feedback);
    }
    section.append(studentMessage, buddyMessage);
    turns.append(section);
  }
  document.getElementById('detail-empty').hidden = orderedTurns.length > 0;
  document.getElementById('detail-content').hidden = false;
  document.getElementById('detail-status').textContent = '';
}

async function loadDetail(sessionId) {
  const status = document.getElementById('detail-status');
  try {
    renderDetail(await api(`/api/practice/sessions/${encodeURIComponent(sessionId)}`));
  } catch (error) {
    if (error.status === 401) {
      status.replaceChildren(element('span', '请登录后查看。 '));
      const link = element('a', '学生登录');
      link.href = '/login';
      status.append(link);
    } else if (error.status === 404) status.textContent = '练习记录不存在或你没有查看权限。';
    else status.textContent = error.message || '暂时无法读取练习详情，请稍后重试。';
  }
}

async function loadTopics() {
  try {
    const [data, scenarioData] = await Promise.all([api('/api/topics'), api('/api/scenarios?grade=3')]);
    const names = [...new Set([...Object.values(data.topics).flat(), ...scenarioData.scenes.map(scene => scene.title)])]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const select = document.getElementById('history-topic');
    for (const name of names) {
      const option = element('option', name);
      option.value = name;
      select.append(option);
    }
  } catch (error) { console.warn('话题筛选列表暂时不可用。', error); }
}

if (listView && detailView) {
  const match = location.pathname.match(/^\/history\/([^/]+)\/?$/);
  if (match) {
    listView.hidden = true;
    detailView.hidden = false;
    loadDetail(decodeURIComponent(match[1]));
  } else {
    loadTopics();
    loadSessions();
    for (const id of ['history-grade', 'history-topic', 'history-status-filter']) {
      document.getElementById(id).addEventListener('change', () => { offset = 0; loadSessions(); });
    }
    document.getElementById('history-prev').addEventListener('click', () => { offset = Math.max(0, offset - pageSize); loadSessions(); });
    document.getElementById('history-next').addEventListener('click', () => { if (pageInfo.hasMore) { offset += pageSize; loadSessions(); } });
  }
}
