import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  try { await fs.access('.env'); console.error('.env已存在。为保护配置，本命令不会覆盖；请先备份并重命名它。'); process.exitCode = 1; }
  catch {
    const template = await fs.readFile('.env.example', 'utf8');
    await fs.writeFile('.env', template.replace('SESSION_SECRET=', `SESSION_SECRET=${randomBytes(48).toString('hex')}`), { flag: 'wx', mode: 0o600 });
    console.log('\n.env已创建，并生成服务端 SESSION_SECRET。请仅在本机 .env 配置 DATABASE_URL、DeepSeek Key 和管理员密码的 scrypt 哈希；不要写入明文密码或提交 .env。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
