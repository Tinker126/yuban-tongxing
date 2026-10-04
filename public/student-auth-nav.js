import { api } from './common.js';

const nav = document.getElementById('student-auth-nav');

function showGuest() {
  const login = document.createElement('a');
  login.href = '/login';
  login.textContent = '学生登录';
  const register = document.createElement('a');
  register.href = '/register';
  register.textContent = '注册';
  nav.replaceChildren(login, register);
}

function showStudent(user) {
  const greeting = document.createElement('span');
  greeting.textContent = `你好，${user.name}`;
  const history = document.createElement('a');
  history.href = '/history';
  history.textContent = '我的练习记录';
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'text-button';
  logout.textContent = '退出登录';
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await api('/api/auth/logout', {});
      showGuest();
    } catch (error) {
      logout.textContent = `退出失败：${error.message}`;
      logout.disabled = false;
    }
  });
  nav.replaceChildren(greeting, history, logout);
}

try {
  const user = await api('/api/auth/me');
  showStudent(user);
} catch (error) {
  if (error.status !== 401) console.warn('暂时无法确认学生登录状态。', error);
  showGuest();
}
