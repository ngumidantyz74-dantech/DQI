import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

// Ephemeral fallback keys for local/preview boots when env secrets are not yet provided.
const EPHEMERAL_SESSION_KEY = crypto.randomBytes(32).toString('hex');
const EPHEMERAL_ENC_KEY = crypto.randomBytes(32);

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const num = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function cleanEnv(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/^["']|["']$/g, '');
}

function resolveDerivAppId(): string {
  const candidates = [
    cleanEnv(process.env.DERIV_APP_ID),
    cleanEnv(process.env.DERIV_CLIENT_ID),
    cleanEnv(process.env.VITE_DERIV_APP_ID),
  ];
  for (const c of candidates) {
    if (/^\d+$/.test(c)) return c;
  }
  return '1089';
}

function resolveDerivWsUrl(): string {
  const raw = cleanEnv(process.env.DERIV_PUBLIC_WS_URL);
  if (!raw) return 'wss://ws.derivws.com/websockets/v3';
  if (raw.startsWith('wss://') || raw.startsWith('ws://')) return raw;
  if (raw.startsWith('https://')) return raw.replace(/^https:\/\//, 'wss://');
  if (raw.startsWith('http://')) return raw.replace(/^http:\/\//, 'ws://');
  if (raw.includes('.')) return `wss://${raw.replace(/^\/+/, '')}`;
  return 'wss://ws.derivws.com/websockets/v3';
}

export const serverConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: parseNonNegativeInt(process.env.PORT, 3000) || 3000,
  appUrl: cleanEnv(process.env.APP_URL) || cleanEnv(process.env.WEB_ORIGIN) || 'http://localhost:3000',
  allowedOrigins: (
    cleanEnv(process.env.QUANT_ALLOWED_ORIGINS) ||
    cleanEnv(process.env.WEB_ORIGIN) ||
    cleanEnv(process.env.APP_URL) ||
    'http://localhost:3000'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: cleanEnv(process.env.DATABASE_URL) || cleanEnv(process.env.POSTGRES_URL) || '',
  databaseUrlUnpooled:
    cleanEnv(process.env.DATABASE_URL_UNPOOLED) ||
    cleanEnv(process.env.POSTGRES_URL_NON_POOLING) ||
    cleanEnv(process.env.DATABASE_URL) ||
    cleanEnv(process.env.POSTGRES_URL) ||
    '',

  derivClientId: cleanEnv(process.env.DERIV_CLIENT_ID),
  derivAppId: resolveDerivAppId(),
  derivRedirectUri: cleanEnv(process.env.DERIV_REDIRECT_URI),
  derivOAuthScopes: cleanEnv(process.env.DERIV_OAUTH_SCOPES) || 'read trade',
  derivApiBaseUrl: cleanEnv(process.env.DERIV_API_BASE_URL) || 'https://api.derivws.com',
  derivAuthBaseUrl: cleanEnv(process.env.DERIV_AUTH_BASE_URL) || 'https://oauth.deriv.com',
  derivPublicWsUrl: resolveDerivWsUrl(),

  sessionSecret: process.env.DQI_SESSION_SECRET || process.env.QUANT_SESSION_SECRET || EPHEMERAL_SESSION_KEY,
  quantAdminPasswordHash: process.env.QUANT_ADMIN_PASSWORD_HASH || '',
  sessionTtlSeconds: parsePositiveNumber(process.env.QUANT_SESSION_TTL_SECONDS, 28800),
  cronSecret: process.env.CRON_SECRET || '',

  // Safety defaults: strictly OFF unless explicitly configured
  liveTradingEnabled: process.env.DQI_LIVE_TRADING_ENABLED === 'true',
  liveMaxStake: parsePositiveNumber(process.env.DQI_LIVE_MAX_STAKE || process.env.DQI_MAX_STAKE, 1),
  liveMaxDailyLoss: parsePositiveNumber(process.env.DQI_LIVE_MAX_DAILY_LOSS || process.env.DQI_MAX_DAILY_LOSS, 5),
  recoveryEnabled: process.env.DQI_RECOVERY_ENABLED === 'true',
  maxRecoveryAttempts: parseNonNegativeInt(process.env.DQI_MAX_RECOVERY_ATTEMPTS, 0),
  maxSessionLoss: parsePositiveNumber(process.env.DQI_MAX_SESSION_LOSS, 5),
  maxDrawdownPercent: parsePositiveNumber(process.env.DQI_MAX_DRAWDOWN_PERCENT, 5),
};

export function getEncryptionKey(): Buffer {
  const b64 = process.env.DQI_ENCRYPTION_KEY_BASE64;
  if (b64) {
    const decoded = Buffer.from(b64, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  }
  return EPHEMERAL_ENC_KEY;
}

export function isDerivOAuthConfigured(): boolean {
  return Boolean(serverConfig.derivClientId || serverConfig.derivAppId);
}
