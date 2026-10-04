export function formatHistoryDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

export function formatDuration(value) {
  if (!Number.isInteger(value) || value < 0) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const seconds = value % 60;
  return hours ? `${hours}小时${String(minutes).padStart(2, '0')}分` : `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

export function formatGrade(grade) {
  return Number.isInteger(grade) ? `${grade}年级` : '—';
}

export function formatStatus(status) {
  return ({ completed: '已完成', active: '进行中', abandoned: '未完成' })[status] || '未知状态';
}
