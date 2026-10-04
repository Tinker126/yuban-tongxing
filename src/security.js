import { randomBytes, scryptSync, scrypt, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);
export const digest = value => createHash('sha256').update(value).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, expected] = encoded.split(':');
  const actual = await scryptAsync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function seal(payload, secret) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}
export function unseal(token, secret) {
  if (typeof token !== 'string' || token.length > 16000) throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid token');
  const signature = createHmac('sha256', secret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (signature.length !== supplied.length || !timingSafeEqual(signature, supplied)) throw new Error('Invalid token');
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}
