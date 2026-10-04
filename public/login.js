const form = document.getElementById('login-form');
const button = document.getElementById('login');
const status = document.getElementById('status');
let submitting = false;

function showError(message) {
  status.textContent = message;
  status.classList.add('error');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;

  // Read live inputs at submit time because a browser may fill them after page load.
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;
  if (!username) return showError('请输入管理员账号');
  if (!password) return showError('请输入密码');

  submitting = true;
  button.disabled = true;
  status.textContent = '正在登录…';
  status.classList.remove('error');

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'ybtc'
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ username, password })
    });

    if (response.status === 200) {
      window.location.assign('/admin');
      return;
    }

    if (response.status === 403) {
      console.warn('Admin login same-origin check failed', {
        status: response.status,
        requestId: response.headers.get('x-request-id') || null
      });
    }

    const messages = {
      400: '提交参数有误，请检查管理员账号和密码。',
      401: '账号或密码不正确。',
      403: '安全校验失败，请从当前网站重新打开登录页。',
      429: '登录请求过于频繁，请稍后再试。',
      500: '服务器暂时出错，请稍后再试。'
    };
    showError(messages[response.status] || `登录失败（HTTP ${response.status}），请稍后重试。`);
  } catch {
    showError('网络连接失败，请检查网络后重试。');
  } finally {
    submitting = false;
    button.disabled = false;
  }
});
