// Run only in the server's interactive SSH terminal. Never accepts secrets in argv.
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

function readHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('请在交互式 SSH 终端运行，勿使用命令参数或聊天传递密钥。');
  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;
    const done = (error) => {
      input.off('data', receive); input.setRawMode(false); input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const receive = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return done(new Error('已取消，配置未写入。'));
        if (char === '\r' || char === '\n') return done();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char !== '\u007f') value += char;
        if (value.length > 256) return done(new Error('输入过长，配置未写入。'));
      }
    };
    process.stdout.write(prompt); input.setRawMode(true); input.on('data', receive); input.resume();
  });
}

let temporary;
try {
  const original = await fs.readFile('.env', 'utf8');
  const values = dotenv.parse(original);
  if (values.TENCENT_ASR_SECRET_ID || values.TENCENT_ASR_SECRET_KEY) {
    throw new Error('现有 ASR 凭据已存在；本工具不覆盖，请先核对现有配置。');
  }
  console.log('配置腾讯云 ASR 英语识别。仅写入 ASR 变量；保留现有数据库、DeepSeek 和 Session 配置。');
  const secretId = await readHidden('粘贴 ASR SecretId 后按回车（不回显）：');
  const secretKey = await readHidden('粘贴 ASR SecretKey 后按回车（不回显）：');
  for (const value of [secretId, secretKey]) {
    if (!/^[A-Za-z0-9]{16,128}$/.test(value)) throw new Error('凭据格式不正确，配置未写入。');
  }
  const updates = { STT_PROVIDER: 'tencent', TENCENT_ASR_SECRET_ID: secretId, TENCENT_ASR_SECRET_KEY: secretKey };
  let result = original;
  for (const [name, value] of Object.entries(updates)) {
    const expression = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, 'gm');
    const matches = result.match(expression) || [];
    if (matches.length > 1) throw new Error('发现重复 ASR 配置，未修改文件。');
    result = matches.length ? result.replace(expression, `${name}=${value}`) : `${result.trimEnd()}\n${name}=${value}\n`;
  }
  // Refuse to clobber a concurrent operator edit.
  if (await fs.readFile('.env', 'utf8') !== original) throw new Error('.env 在输入期间已被修改，请重新运行。');
  temporary = `.env.stt-${randomBytes(8).toString('hex')}`;
  await fs.writeFile(temporary, result, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, '.env'); temporary = undefined;
  await fs.chmod('.env', 0o600);
  console.log('ASR 凭据已写入服务器 .env（600）；未显示密钥。请运行 npm run stt:check。');
} catch (error) {
  console.error(error?.code ? '无法安全写入服务器配置；请检查目录和文件权限。' : error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await fs.unlink(temporary).catch(() => {});
}
