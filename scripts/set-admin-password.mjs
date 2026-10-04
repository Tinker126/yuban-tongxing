import fs from 'node:fs/promises';
import { hashPassword } from '../src/security.js';

function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('请在本机交互式终端运行 npm run admin:password；密码不会通过命令参数或管道读取。');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    let finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(result);
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return done(new Error('已取消。'));
        if (char === '\r' || char === '\n') return done(null, value);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

try {
  const password = await readHidden('请输入新的管理员密码（不回显）：');
  const confirm = await readHidden('请再次输入确认（不回显）：');
  if (password !== confirm) throw new Error('两次输入不一致，未修改配置。');
  if (password.length < 8 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 256) {
    throw new Error('密码须为8至128个字符，UTF-8编码不超过256字节。');
  }
  let envText = await fs.readFile('.env', 'utf8');
  const lines = envText.split(/\r?\n/);
  const matching = lines.filter(line => /^\s*ADMIN_PASSWORD_HASH\s*=/.test(line));
  if (matching.length > 1) throw new Error('.env 中存在多个 ADMIN_PASSWORD_HASH 配置，未修改文件。');
  const hash = hashPassword(password);
  if (matching.length) {
    envText = lines.map(line => /^\s*ADMIN_PASSWORD_HASH\s*=/.test(line) ? `ADMIN_PASSWORD_HASH=${hash}` : line).join('\n');
  } else {
    envText = `${envText.replace(/\s*$/, '')}\nADMIN_PASSWORD_HASH=${hash}\n`;
  }
  await fs.writeFile('.env', envText, { encoding: 'utf8' });
  console.log('本地 .env 已更新为新的 scrypt 哈希；未保存或输出明文密码。请重新运行 npm run admin:provision 同步数据库。');
} catch (error) {
  console.error(`未更新管理员密码：${error.message}`);
  process.exitCode = 1;
}
