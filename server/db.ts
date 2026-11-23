import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { serverConfig } from './config.ts';

export interface PaperAccountRecord {
  paper_account_id: number;
  account_name: string;
  currency: string;
  starting_equity: number;
  current_equity: number;
  reserved_stake: number;
}

export interface PaperPositionRecord {
  position_id: number;
  paper_account_id: number;
  strategy_id: number | null;
  symbol_code: string;
  timeframe: string;
  contract_type: string;
  barrier: string | null;
  direction: 'BUY' | 'SELL';
  stake: number;
  payout_multiplier: number;
  entry_price: number;
  entry_quote_str: string;
  exit_price: number | null;
  exit_quote_str: string | null;
  opened_at: string;
  expires_at: string;
  settled_at: string | null;
  status: 'OPEN' | 'WON' | 'LOST' | 'CANCELLED';
  profit_loss: number | null;
  signal_snapshot: Record<string, unknown>;
}

export interface PaperStrategyRecord {
  strategy_id: number;
  name: string;
  description: string;
  symbol_code: string;
  timeframe: string;
  contract_family: string;
  parameters: Record<string, unknown>;
  blocks: Record<string, unknown>;
  enabled: boolean;
  auto_enabled: boolean;
  risk_fraction: number;
  expiry_seconds: number;
  payout_multiplier: number;
  min_confidence: number;
  cooldown_seconds: number;
  last_evaluated_at: string | null;
  created_at: string;
}

export interface BoundedRecoveryPolicy {
  mode: 'OFF' | 'COOLDOWN' | 'FIXED_STAKE_REASSESSMENT' | 'LIMITED_RECOVERY_PLAN';
  real_account_opt_in: boolean;
  max_attempts_session: number;
  cooldown_seconds: number;
  max_stake: number;
  max_balance_percent: number;
  max_session_loss: number;
  max_daily_loss: number;
  max_drawdown_percent: number;
  max_consecutive_losses: number;
  max_open_contracts: number;
  attempts_used_session: number;
  session_realized_pnl: number;
  consecutive_losses: number;
  cooldown_until: string | null;
}

export interface AutomationControlState {
  enabled: boolean;
  kill_switch: boolean;
  paused_reason: string | null;
  updated_at: string;
}

export interface LiveExecutionGateState {
  live_enabled: boolean;
  automation_enabled: boolean;
  kill_switch: boolean;
  require_manual_approval: boolean;
  max_stake: number;
  max_daily_loss: number;
  max_open_contracts: number;
  updated_at: string;
}

export interface LiveIntentRecord {
  intent_id: string;
  environment: 'REAL';
  account_id: string;
  external_ref: string;
  symbol_code: string;
  contract_type: string;
  barrier: string | null;
  currency: string;
  stake: number;
  duration: number;
  duration_unit: string;
  proposal_id: string;
  quoted_price: number;
  quoted_payout: number;
  quote_expires_at: string;
  status: 'PENDING_APPROVAL' | 'EXECUTING' | 'EXECUTED' | 'REJECTED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN';
  broker_contract_id: string | null;
  created_at: string;
}

export interface AutomationAlertRecord {
  alert_id: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  alert_code: string;
  message: string;
  acknowledged_at: string | null;
  created_at: string;
}

// Preview runtime store (used cleanly ONLY when DATABASE_URL is not configured in preview)
// Never fabricates broker balances, real accounts, or fake market prices.
class PreviewRuntimeStore {
  claimedAdminHash: string | null = null;
  paperAccount: PaperAccountRecord = {
    paper_account_id: 1,
    account_name: 'DQI Research Paper Account',
    currency: 'USD',
    starting_equity: 10000,
    current_equity: 10000,
    reserved_stake: 0,
  };
  nextPositionId = 1;
  positions: PaperPositionRecord[] = [];
  nextStrategyId = 1;
  strategies: PaperStrategyRecord[] = [];
  nextAlertId = 1;
  alerts: AutomationAlertRecord[] = [];
  automationControl: AutomationControlState = {
    enabled: false,
    kill_switch: false,
    paused_reason: 'Paused by default until explicitly enabled',
    updated_at: new Date().toISOString(),
  };
  recoveryPolicy: BoundedRecoveryPolicy = {
    mode: 'OFF',
    real_account_opt_in: false,
    max_attempts_session: serverConfig.maxRecoveryAttempts,
    cooldown_seconds: 60,
    max_stake: serverConfig.liveMaxStake,
    max_balance_percent: 1.0,
    max_session_loss: serverConfig.maxSessionLoss,
    max_daily_loss: serverConfig.liveMaxDailyLoss,
    max_drawdown_percent: serverConfig.maxDrawdownPercent,
    max_consecutive_losses: 3,
    max_open_contracts: 1,
    attempts_used_session: 0,
    session_realized_pnl: 0,
    consecutive_losses: 0,
    cooldown_until: null,
  };
  liveGate: LiveExecutionGateState = {
    live_enabled: false,
    automation_enabled: false,
    kill_switch: true,
    require_manual_approval: true,
    max_stake: serverConfig.liveMaxStake,
    max_daily_loss: serverConfig.liveMaxDailyLoss,
    max_open_contracts: 1,
    updated_at: new Date().toISOString(),
  };
  liveIntents: LiveIntentRecord[] = [];
  oauthTransactions = new Map<string, { verifier: string; redirectUri: string; expiresAt: number }>();
  activeCalibration: Record<string, { slope: number; intercept: number; sample_count: number; brier_score: number }> = {};
  lastRunAt: string | null = null;
}

export const previewStore = new PreviewRuntimeStore();

let poolInstance: Pool | null = null;

export function getPool(): Pool | null {
  if (!serverConfig.databaseUrl) return null;
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: serverConfig.databaseUrl,
      max: 10,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      ssl: serverConfig.databaseUrl.includes('neon.tech') || serverConfig.isProduction
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }
  return poolInstance;
}

export async function checkDatabaseHealth(): Promise<{
  configured: boolean;
  connected: boolean;
  mode: 'NEON_POSTGRES' | 'PREVIEW_MEMORY';
  appliedMigrations: string[];
  availableMigrations: string[];
}> {
  const migrationsDir = path.resolve(process.cwd(), 'database', 'migrations');
  const availableMigrations = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const pool = getPool();
  if (!pool) {
    return {
      configured: false,
      connected: false,
      mode: 'PREVIEW_MEMORY',
      appliedMigrations: [],
      availableMigrations,
    };
  }
  try {
    await pool.query('SELECT 1');
    let appliedMigrations: string[] = [];
    try {
      const res = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
      appliedMigrations = res.rows.map((r) => String(r.version));
    } catch {
      appliedMigrations = [];
    }
    return {
      configured: true,
      connected: true,
      mode: 'NEON_POSTGRES',
      appliedMigrations,
      availableMigrations,
    };
  } catch {
    return {
      configured: true,
      connected: false,
      mode: 'PREVIEW_MEMORY',
      appliedMigrations: [],
      availableMigrations,
    };
  }
}

export async function runPendingMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const connStr = serverConfig.databaseUrlUnpooled;
  if (!connStr) {
    throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is required to run SQL migrations.');
  }
  const directPool = new Pool({
    connectionString: connStr,
    max: 1,
    ssl: connStr.includes('neon.tech') || serverConfig.isProduction ? { rejectUnauthorized: false } : undefined,
  });
  const migrationsDir = path.resolve(process.cwd(), 'database', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  const client = await directPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(740031200)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum varchar(64) NOT NULL
      )
    `);
    const existingRes = await client.query('SELECT version FROM schema_migrations');
    const existing = new Set(existingRes.rows.map((r) => String(r.version)));

    for (const file of files) {
      if (existing.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [file, checksum]
      );
      applied.push(file);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(740031200)');
    } catch {
      // ignore unlock error
    }
    client.release();
    await directPool.end();
  }
  return { applied, skipped };
}
