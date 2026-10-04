// Generate a replacement password and hash without accepting secrets in command-line arguments.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/security.js';
const password = randomBytes(18).toString('base64url');
console.log(`新密码（请安全保存）：${password}\n把以下整行替换到.env，然后重启服务：\nADMIN_PASSWORD_HASH=${hashPassword(password)}`);
