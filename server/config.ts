import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

export const DEFAULT_DERIV_PARTNER_APP_ID = '352P3WGh6Jm4clLrnbq6u';
export const DEFAULT_DERIV_CALLBACK_URL = 'https://dqideriv.pipflowtrade.site/api/v1/auth/deriv/callback';

// Deterministic fallback key material when DQI_ENCRYPTION_KEY_BASE64 / DQI_SESSION_SECRET are not set in Vercel env.
// Keeps PKCE cookies decryptable across separate Vercel serverless Lambda cold starts.
function deriveFallbackKeyMaterial(): Buffer {
  const seed = [
    process.env.DQI_SESSION_SECRET,
    process.env.QUANT_SESSION_SECRET,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.CRON_SECRET,
    process.env.VERCEL_PROJECT_ID,
    DEFAULT_DERIV_PARTNER_APP_ID,
    DEFAULT_DERIV_CALLBACK_URL,
    'dqi-stateless-v1',
  ]
    .filter(Boolean)
    .join('|');
  return crypto.createHash('sha256').update(seed).digest();
}

const FALLBACK_KEY_BYTES = deriveFallbackKeyMaterial();
const EPHEMERAL_SESSION_KEY = FALLBACK_KEY_BYTES.toString('hex');
const EPHEMERAL_ENC_KEY = FALLBACK_KEY_BYTES;

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

function resolveDerivClientId(): string {
  const candidates = [
    cleanEnv(process.env.DERIV_CLIENT_ID),
    cleanEnv(process.env.DERIV_APP_ID),
    cleanEnv(process.env.VITE_DERIV_APP_ID),
  ];
  for (const c of candidates) {
    if (c && c !== '1089') return c;
  }
  return DEFAULT_DERIV_PARTNER_APP_ID;
}

function resolveDerivRedirectUri(): string {
  const raw = cleanEnv(process.env.DERIV_REDIRECT_URI);
  const clientId = resolveDerivClientId();
  if (
    !raw ||
    raw.startsWith('http://localhost') ||
    raw.startsWith('http://127.0.0.1') ||
    (clientId === DEFAULT_DERIV_PARTNER_APP_ID &&
      (raw.includes('.vercel.app') || !raw.startsWith('https://dqideriv.pipflowtrade.site/')))
  ) {
    return DEFAULT_DERIV_CALLBACK_URL;
  }
  return raw;
}

function resolveDerivOAuthScopes(): string {
  const raw = cleanEnv(process.env.DERIV_OAUTH_SCOPES);
  if (!raw || raw === 'read trade' || raw.split(/\s+/).includes('read')) {
    return 'trade account_manage';
  }
  return raw;
}

function resolveDerivAuthBaseUrl(): string {
  const raw = cleanEnv(process.env.DERIV_AUTH_BASE_URL);
  if (!raw || raw.includes('oauth.deriv.com')) {
    return 'https://auth.deriv.com';
  }
  return raw;
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
  appUrl:
    cleanEnv(process.env.APP_URL) ||
    cleanEnv(process.env.WEB_ORIGIN) ||
    'https://dqideriv.pipflowtrade.site',
  allowedOrigins: (
    cleanEnv(process.env.QUANT_ALLOWED_ORIGINS) ||
    cleanEnv(process.env.WEB_ORIGIN) ||
    cleanEnv(process.env.APP_URL) ||
    'http://localhost:3000,https://dqideriv.pipflowtrade.site'
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

  derivClientId: resolveDerivClientId(),
  derivAppId: resolveDerivAppId(),
  derivRedirectUri: resolveDerivRedirectUri(),
  derivOAuthScopes: resolveDerivOAuthScopes(),
  derivApiBaseUrl: cleanEnv(process.env.DERIV_API_BASE_URL) || 'https://api.derivws.com',
  derivAuthBaseUrl: resolveDerivAuthBaseUrl(),
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
  return Boolean(serverConfig.derivClientId && serverConfig.derivRedirectUri);
}
