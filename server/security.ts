import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getEncryptionKey, serverConfig } from './config.ts';

export const DQI_SESSION_COOKIE = 'dqi_session';
export const QUANT_ADMIN_COOKIE = 'dqi_quant_admin';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted payload format');
  }
  const [, ivText, tagText, cipherText] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// Password hashing & verification (supports scrypt$salt$hash and pbkdf2_sha256$iter$salt$hash)
export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  if (!encodedHash || !password) return false;
  if (encodedHash.startsWith('scrypt$')) {
    const parts = encodedHash.split('$');
    if (parts.length !== 3) return false;
    const [, salt, storedHex] = parts;
    const derived = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(storedHex, 'hex');
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  }
  if (encodedHash.startsWith('pbkdf2_sha256$')) {
    const parts = encodedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number.parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'base64');
    const stored = Buffer.from(parts[3], 'base64');
    if (!Number.isFinite(iterations) || iterations < 10000) return false;
    const derived = crypto.pbkdf2Sync(password, salt, iterations, stored.length, 'sha256');
    return crypto.timingSafeEqual(derived, stored);
  }
  return false;
}

// HMAC-signed stateless admin session token (verified server-side)
export function signAdminSessionToken(ttlSeconds = serverConfig.sessionTtlSeconds): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomToken(12);
  const payload = `${exp}.${nonce}`;
  const sig = crypto
    .createHmac('sha256', serverConfig.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminSessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expText, nonce, sig] = parts;
  const exp = Number.parseInt(expText, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac('sha256', serverConfig.sessionSecret)
    .update(`${expText}.${nonce}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Cookie helper honoring AI Studio iFrame & HTTPS constraints
export function setAuthCookie(res: Response, name: string, value: string, maxAgeSeconds: number, req?: Request): void {
  const isHttps = req ? (req.secure || req.headers['x-forwarded-proto'] === 'https') : serverConfig.isProduction;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function clearAuthCookie(res: Response, name: string, req?: Request): void {
  const isHttps = req ? (req.secure || req.headers['x-forwarded-proto'] === 'https') : serverConfig.isProduction;
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

// Same-origin / CSRF guard for cookie-authenticated mutating requests
export function verifyMutationOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const requestedWith = req.headers['x-requested-with'];
  if (requestedWith === 'DQI-Client') {
    next();
    return;
  }
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      const allowedHost = Array.isArray(host) ? host[0] : host;
      if (parsed.host === allowedHost || serverConfig.allowedOrigins.includes(origin)) {
        next();
        return;
      }
    } catch {
      res.status(403).json({ error: 'INVALID_ORIGIN' });
      return;
    }
    res.status(403).json({ error: 'ORIGIN_MISMATCH' });
    return;
  }
  next();
}

// In-memory login attempt rate limiter (8 attempts per 15 min window)
const loginAttempts = new Map<string, number[]>();

export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < windowMs);
  loginAttempts.set(ip, attempts);
  if (attempts.length >= 8) {
    const oldest = attempts[0];
    return { allowed: false, retryAfterSec: Math.ceil((oldest + windowMs - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordFailedLoginAttempt(ip: string): void {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < windowMs);
  attempts.push(now);
  loginAttempts.set(ip, attempts);
}

export function clearFailedLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

export function redactSensitive(text: string): string {
  return text
    .replace(/token[=:]\s*[A-Za-z0-9._-]+/gi, 'token=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}
