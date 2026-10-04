import { fetchWithTimeout } from './fetch-with-timeout.js';

export async function api(path, body, timeout = 55000, method = 'POST') {
  const options = { credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) Object.assign(options, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ybtc' }, body: JSON.stringify(body) });
  let response;
  try { response = await fetchWithTimeout(fetch, path, options, timeout); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? '连接超时，请重试。' : '网络连接失败，请检查网络后重试。'); }
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务响应异常（${response.status}），请稍后重试。`); }
  if (!response.ok) { const e = new Error(data.error || `请求失败（${response.status}）`); e.status = response.status; throw e; }
  return data;
}
export function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
