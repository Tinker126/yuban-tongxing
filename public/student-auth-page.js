import { api } from './common.js';

const form = document.querySelector('[data-auth-form]');
const mode = form.dataset.authForm;
const status = document.getElementById('status');
const submit = form.querySelector('button[type="submit"]');

if (mode === 'login' && new URL(location.href).searchParams.get('registered') === '1') {
  status.textContent = '注册成功，请登录。';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  status.classList.remove('error');
  status.textContent = mode === 'register' ? '正在创建账号…' : '正在登录…';

  const username = form.elements.namedItem('username').value.trim();
  const password = form.elements.namedItem('password').value;
  const body = mode === 'register'
    ? {
        username,
        name: form.elements.namedItem('name').value.trim(),
        grade: Number(form.elements.namedItem('grade').value),
        password
      }
    : { username, password };

  try {
    await api(`/api/auth/${mode}`, body);
    location.replace(mode === 'register' ? '/login?registered=1' : '/');
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
    form.elements.namedItem('password').value = '';
    submit.disabled = false;
  }
});
