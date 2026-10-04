import { api, element } from './common.js';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 20;
const HISTORY_SIZE = 50;
let studentOffset = 0;
let studentTotal = 0;
let selectedStudentId = null;
let historyOffset = 0;

function handleError(error) {
  if (error.status === 401) { location.replace('/admin/login'); return; }
  $('status').textContent = error.message;
  $('status').classList.add('error');
}

function duration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
  if (hours) return `${hours}小时${String(minutes).padStart(2, '0')}分${String(secs).padStart(2, '0')}秒`;
  if (minutes) return `${minutes}分${String(secs).padStart(2, '0')}秒`;
  return `${secs}秒`;
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function statusLabel(status) {
  return ({ active: '进行中', completed: '已完成', abandoned: '已中止' })[status] || status || '—';
}

function emptyRow(body, columns, message) {
  const row = element('tr'), cell = element('td', message, 'admin-empty');
  cell.colSpan = columns; row.append(cell); body.append(row);
}

async function showPractice(sessionId) {
  const panel = $('practice-detail');
  panel.hidden = false;
  $('practice-summary').textContent = '正在读取练习…';
  $('turns').replaceChildren();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const result = await api(`/api/admin/practice/sessions/${encodeURIComponent(sessionId)}`);
    const s = result.session;
    $('practice-summary').replaceChildren(
      element('span', `学生：${s.studentName}（${s.username}）`),
      element('span', `开始：${dateTime(s.startedAt)}`),
      element('span', `结束：${dateTime(s.endedAt)}`),
      element('span', `${s.sceneTitle ? `情景：${s.sceneTitle}` : s.topic} · ${s.grade}年级`),
      element('span', `时长：${duration(s.durationSeconds)}`),
      element('span', `${s.turnCount}轮 · ${statusLabel(s.status)}`)
    );
    const turns = $('turns');
    if (!result.turns.length) {
      turns.append(element('p', '本次练习还没有保存对话轮次。', 'admin-empty'));
      return;
    }
    for (const turn of result.turns) {
      const card = element('article', undefined, 'turn-card');
      card.append(element('h3', `第 ${turn.turnNumber} 轮 · ${dateTime(turn.createdAt)}`));
      card.append(element('p', '学生转写', 'turn-label'), element('p', turn.studentText));
      card.append(element('p', 'AI 英文回复', 'turn-label'), element('p', turn.aiReply));
      if (turn.feedback && typeof turn.feedback === 'object') {
        const feedback = element('div', undefined, 'turn-feedback');
        if (turn.feedback.highlight) feedback.append(element('p', `表达亮点：${turn.feedback.highlight}`));
        if (turn.feedback.suggestion) feedback.append(element('p', `改进建议：${turn.feedback.suggestion}`));
        card.append(feedback);
      }
      turns.append(card);
    }
  } catch (error) { handleError(error); }
}

async function loadSummary() {
  const result = await api('/api/admin/summary');
  $('student-count').textContent = result.studentCount;
  $('today-students').textContent = result.todayPracticeUsers;
  $('today-sessions').textContent = result.todayPracticeSessions;
  $('total-sessions').textContent = result.totalPracticeSessions;
  $('total-duration').textContent = duration(result.totalDurationSeconds);
  const body = $('recent-sessions'); body.replaceChildren();
  if (!result.recentSessions.length) return emptyRow(body, 7, '目前还没有学生练习记录。');
  for (const session of result.recentSessions) {
    const row = element('tr');
    row.append(element('td', `${session.studentName}（${session.username}）`), element('td', dateTime(session.startedAt)),
      element('td', `${session.sceneTitle ? `情景：${session.sceneTitle}` : session.topic} · ${session.grade}年级`), element('td', duration(session.durationSeconds)),
      element('td', `${session.turnCount}轮`), element('td', statusLabel(session.status)));
    const actionCell = element('td'), button = element('button', '查看对话', 'secondary');
    button.type = 'button'; button.addEventListener('click', () => showPractice(session.id));
    actionCell.append(button); row.append(actionCell); body.append(row);
  }
}

async function loadStudents() {
  const result = await api(`/api/admin/students?limit=${PAGE_SIZE}&offset=${studentOffset}`);
  studentTotal = result.pagination.total;
  const body = $('students'); body.replaceChildren();
  if (!result.students.length) emptyRow(body, 7, '目前还没有学生账号。');
  for (const student of result.students) {
    const row = element('tr');
    row.append(element('td', student.name), element('td', student.username), element('td', `${student.grade}年级`),
      element('td', String(student.totalPracticeSessions)), element('td', duration(student.totalDurationSeconds)),
      element('td', dateTime(student.lastPracticeAt)));
    const cell = element('td'), button = element('button', '学生详情', 'secondary');
    button.type = 'button'; button.addEventListener('click', () => loadStudent(student.id, 0));
    cell.append(button); row.append(cell); body.append(row);
  }
  const pages = Math.max(1, Math.ceil(studentTotal / PAGE_SIZE));
  $('students-page').textContent = `${Math.floor(studentOffset / PAGE_SIZE) + 1} / ${pages} 页 · 共 ${studentTotal} 人`;
  $('students-prev').disabled = studentOffset === 0;
  $('students-next').disabled = studentOffset + PAGE_SIZE >= studentTotal;
}

async function loadStudent(studentId, offset = historyOffset) {
  selectedStudentId = studentId; historyOffset = offset;
  const panel = $('student-detail'); panel.hidden = false;
  $('student-summary').textContent = '正在读取学生记录…';
  $('student-sessions').replaceChildren();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const result = await api(`/api/admin/students/${encodeURIComponent(studentId)}?limit=${HISTORY_SIZE}&offset=${historyOffset}`);
    const { student, stats, pagination } = result;
    $('detail-title').textContent = `${student.name} · ${student.username}`;
    $('student-summary').replaceChildren(
      element('span', `${student.grade}年级`),
      element('span', `累计练习：${stats.totalPracticeSessions}次`),
      element('span', `累计时长：${duration(stats.totalDurationSeconds)}`),
      element('span', `累计对话：${stats.totalTurnCount}轮`),
      element('span', `最近练习：${dateTime(stats.lastPracticeAt)}`)
    );
    const body = $('student-sessions'); body.replaceChildren();
    if (!result.sessions.length) emptyRow(body, 6, '这个学生还没有练习记录。');
    for (const session of result.sessions) {
      const row = element('tr');
      row.append(element('td', dateTime(session.startedAt)), element('td', `${session.sceneTitle ? `情景：${session.sceneTitle}` : session.topic} · ${session.grade}年级`),
        element('td', duration(session.durationSeconds)), element('td', `${session.turnCount}轮`), element('td', statusLabel(session.status)));
      const cell = element('td'), button = element('button', '完整对话', 'secondary');
      button.type = 'button'; button.addEventListener('click', () => showPractice(session.id));
      cell.append(button); row.append(cell); body.append(row);
    }
    const pages = Math.max(1, Math.ceil(pagination.total / HISTORY_SIZE));
    $('history-page').textContent = `${Math.floor(historyOffset / HISTORY_SIZE) + 1} / ${pages} 页 · 共 ${pagination.total} 次`;
    $('history-prev').disabled = historyOffset === 0;
    $('history-next').disabled = !pagination.hasMore;
  } catch (error) { handleError(error); }
}

async function refresh() {
  const button = $('refresh'); button.disabled = true;
  $('status').textContent = '正在读取数据库…'; $('status').classList.remove('error');
  try {
    await Promise.all([loadSummary(), loadStudents()]);
    $('status').textContent = `数据库数据已更新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) { handleError(error); }
  finally { button.disabled = false; }
}

$('refresh').addEventListener('click', refresh);
$('students-prev').addEventListener('click', async () => { studentOffset = Math.max(0, studentOffset - PAGE_SIZE); try { await loadStudents(); } catch (error) { handleError(error); } });
$('students-next').addEventListener('click', async () => { studentOffset += PAGE_SIZE; try { await loadStudents(); } catch (error) { handleError(error); } });
$('history-prev').addEventListener('click', () => { if (selectedStudentId) loadStudent(selectedStudentId, Math.max(0, historyOffset - HISTORY_SIZE)); });
$('history-next').addEventListener('click', () => { if (selectedStudentId) loadStudent(selectedStudentId, historyOffset + HISTORY_SIZE); });
$('close-student').addEventListener('click', () => { $('student-detail').hidden = true; });
$('close-practice').addEventListener('click', () => { $('practice-detail').hidden = true; });
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await api('/api/admin/logout', {}); location.replace('/admin/login'); }
  catch (error) { handleError(error); $('logout').disabled = false; }
});

try {
  const user = await api('/api/admin/me');
  $('admin-name').textContent = `管理员 · ${user.name}`;
  await refresh();
} catch (error) { handleError(error); }
