BEGIN;

CREATE TABLE IF NOT EXISTS live_execution_control (
  control_id smallint PRIMARY KEY DEFAULT 1 CHECK (control_id = 1),
  live_enabled boolean NOT NULL DEFAULT false,
  automation_enabled boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT true,
  require_manual_approval boolean NOT NULL DEFAULT true,
  max_stake numeric(20,8) NOT NULL DEFAULT 1 CHECK (max_stake > 0),
  max_daily_loss numeric(20,8) NOT NULL DEFAULT 5 CHECK (max_daily_loss > 0),
  max_open_contracts integer NOT NULL DEFAULT 1 CHECK (max_open_contracts BETWEEN 1 AND 5),
  updated_by uuid REFERENCES app_users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO live_execution_control(control_id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS live_trade_intents (
  intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  credential_id uuid NOT NULL REFERENCES deriv_credentials(credential_id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES trading_accounts(account_id) ON DELETE RESTRICT,
  environment varchar(8) NOT NULL CHECK (environment = 'REAL'),
  symbol_code varchar(80) NOT NULL,
  contract_type varchar(20) NOT NULL CHECK (contract_type IN ('CALL','PUT','DIGITOVER','DIGITUNDER','DIGITMATCH','DIGITDIFF','DIGITEVEN','DIGITODD')),
  currency varchar(12) NOT NULL,
  stake numeric(20,8) NOT NULL CHECK (stake > 0),
  duration integer NOT NULL CHECK (duration BETWEEN 30 AND 86400),
  duration_unit varchar(2) NOT NULL DEFAULT 's' CHECK (duration_unit IN ('s','m','h','d','t')),
  contract_expires_at timestamptz,
  proposal_id varchar(128),
  quoted_price numeric(20,8),
  quoted_payout numeric(20,8),
  quote_expires_at timestamptz,
  status varchar(20) NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status IN ('PENDING_APPROVAL','EXECUTING','EXECUTED','REJECTED','EXPIRED','FAILED','UNKNOWN')),
  broker_contract_id varchar(128),
  broker_transaction_id varchar(128),
  execution_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES app_users(user_id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_live_intents_owner_recent
  ON live_trade_intents(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_intents_status
  ON live_trade_intents(status, created_at);

CREATE TABLE IF NOT EXISTS live_daily_risk_state (
  account_id uuid NOT NULL REFERENCES trading_accounts(account_id) ON DELETE CASCADE,
  risk_date date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  opening_balance numeric(24,8) NOT NULL CHECK (opening_balance >= 0),
  max_daily_loss numeric(24,8) NOT NULL CHECK (max_daily_loss > 0),
  halted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,risk_date)
);

CREATE TABLE IF NOT EXISTS live_execution_events (
  event_id bigserial PRIMARY KEY,
  intent_id uuid REFERENCES live_trade_intents(intent_id) ON DELETE SET NULL,
  owner_user_id uuid REFERENCES app_users(user_id) ON DELETE SET NULL,
  event_type varchar(60) NOT NULL,
  outcome varchar(20) NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','ERROR','INFO')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_contract_reconciliation (
  reconciliation_id bigserial PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES trading_accounts(account_id) ON DELETE CASCADE,
  broker_contract_id varchar(128) NOT NULL,
  broker_status varchar(40),
  broker_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, broker_contract_id)
);

COMMIT;
