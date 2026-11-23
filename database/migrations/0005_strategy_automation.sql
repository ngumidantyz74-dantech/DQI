BEGIN;

ALTER TABLE paper_strategies
  ADD COLUMN IF NOT EXISTS execution_mode varchar(12) NOT NULL DEFAULT 'PAPER'
    CHECK (execution_mode IN ('PAPER')),
  ADD COLUMN IF NOT EXISTS auto_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_fraction numeric(8,7) NOT NULL DEFAULT 0.005
    CHECK (risk_fraction > 0 AND risk_fraction <= 0.02),
  ADD COLUMN IF NOT EXISTS expiry_seconds integer NOT NULL DEFAULT 300
    CHECK (expiry_seconds BETWEEN 30 AND 86400),
  ADD COLUMN IF NOT EXISTS payout_multiplier numeric(12,6) NOT NULL DEFAULT 0.8
    CHECK (payout_multiplier > 0 AND payout_multiplier <= 10),
  ADD COLUMN IF NOT EXISTS min_confidence numeric(8,7) NOT NULL DEFAULT 0.65
    CHECK (min_confidence BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS cooldown_seconds integer NOT NULL DEFAULT 300
    CHECK (cooldown_seconds BETWEEN 30 AND 86400),
  ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_signal_epoch bigint;

CREATE TABLE IF NOT EXISTS quant_automation_control (
  control_id smallint PRIMARY KEY DEFAULT 1 CHECK (control_id = 1),
  enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  paused_reason text,
  updated_by varchar(120) NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO quant_automation_control(control_id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS quant_strategy_runs (
  run_id bigserial PRIMARY KEY,
  strategy_id bigint NOT NULL REFERENCES paper_strategies(strategy_id) ON DELETE CASCADE,
  symbol_code varchar(80) NOT NULL,
  timeframe varchar(8) NOT NULL,
  candle_epoch bigint NOT NULL,
  direction varchar(8) NOT NULL CHECK (direction IN ('BUY','SELL','NEUTRAL')),
  confidence numeric(8,7) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  outcome varchar(20) NOT NULL CHECK (outcome IN ('OPENED','SKIPPED','ERROR')),
  paper_position_id bigint REFERENCES paper_positions(position_id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(strategy_id, symbol_code, timeframe, candle_epoch)
);
CREATE INDEX IF NOT EXISTS idx_quant_strategy_runs_recent
  ON quant_strategy_runs(strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quant_alerts (
  alert_id bigserial PRIMARY KEY,
  severity varchar(12) NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  alert_code varchar(80) NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quant_alerts_unacknowledged
  ON quant_alerts(created_at DESC) WHERE acknowledged_at IS NULL;

CREATE TABLE IF NOT EXISTS quant_worker_heartbeat (
  worker_name varchar(80) PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status varchar(20) NOT NULL DEFAULT 'STARTING',
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
