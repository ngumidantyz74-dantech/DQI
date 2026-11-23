BEGIN;

-- Phase 7 forward-only migration: Digits Intelligence, Match/Differ Specialist,
-- Volatility Context, Strategy Block Graphs, and Bounded Loss Recovery.

ALTER TABLE market_ticks
  ADD COLUMN IF NOT EXISTS raw_quote text,
  ADD COLUMN IF NOT EXISTS quote_precision smallint,
  ADD COLUMN IF NOT EXISTS last_digit smallint CHECK (last_digit IS NULL OR last_digit BETWEEN 0 AND 9),
  ADD COLUMN IF NOT EXISTS source varchar(40) NOT NULL DEFAULT 'DERIV_PUBLIC_WS';

CREATE TABLE IF NOT EXISTS digit_analytics_snapshots (
  snapshot_id       bigserial PRIMARY KEY,
  symbol_code       varchar(80) NOT NULL,
  window_size       integer NOT NULL CHECK (window_size >= 10),
  sample_count      integer NOT NULL CHECK (sample_count >= 0),
  latest_digit      smallint CHECK (latest_digit IS NULL OR latest_digit BETWEEN 0 AND 9),
  latest_quote      text,
  quote_precision   smallint,
  digit_counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  entropy_bits      numeric(10,6),
  chi_square_stat   numeric(14,6),
  chi_square_p      numeric(10,6),
  volatility_regime varchar(30) NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  data_quality      varchar(30) NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  as_of_epoch       bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digit_snapshots_symbol_time
  ON digit_analytics_snapshots(symbol_code, created_at DESC);

CREATE TABLE IF NOT EXISTS match_differ_evaluations (
  evaluation_id     bigserial PRIMARY KEY,
  symbol_code       varchar(80) NOT NULL,
  contract_type     varchar(20) NOT NULL CHECK (contract_type IN ('DIGITMATCH','DIGITDIFF','DIGITOVER','DIGITUNDER','DIGITEVEN','DIGITODD')),
  barrier_digit     smallint NOT NULL CHECK (barrier_digit BETWEEN 0 AND 9),
  window_size       integer NOT NULL,
  sample_count      integer NOT NULL,
  observed_rate     numeric(10,6) NOT NULL,
  ci_low            numeric(10,6) NOT NULL,
  ci_high           numeric(10,6) NOT NULL,
  proposal_ask      numeric(20,8),
  proposal_payout   numeric(20,8),
  break_even_prob   numeric(10,6),
  estimated_ev      numeric(20,8),
  volatility_regime varchar(30) NOT NULL,
  status            varchar(40) NOT NULL,
  status_reason     text NOT NULL,
  model_version     varchar(60) NOT NULL DEFAULT 'dqi_digits_v1',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_differ_symbol_time
  ON match_differ_evaluations(symbol_code, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_block_graphs (
  graph_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid REFERENCES app_users(user_id) ON DELETE SET NULL,
  name              varchar(120) NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  environment       varchar(16) NOT NULL DEFAULT 'PAPER' CHECK (environment IN ('MANUAL','PAPER','LIVE')),
  symbol_code       varchar(80) NOT NULL,
  contract_family   varchar(30) NOT NULL,
  graph_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bounded_recovery_policies (
  policy_id              smallint PRIMARY KEY DEFAULT 1 CHECK (policy_id = 1),
  mode                   varchar(32) NOT NULL DEFAULT 'OFF'
                         CHECK (mode IN ('OFF','COOLDOWN','FIXED_STAKE_REASSESSMENT','LIMITED_RECOVERY_PLAN')),
  real_account_opt_in    boolean NOT NULL DEFAULT false,
  max_attempts_session   integer NOT NULL DEFAULT 0 CHECK (max_attempts_session BETWEEN 0 AND 5),
  cooldown_seconds       integer NOT NULL DEFAULT 60 CHECK (cooldown_seconds BETWEEN 10 AND 3600),
  max_stake              numeric(20,8) NOT NULL DEFAULT 1.0 CHECK (max_stake > 0),
  max_balance_percent    numeric(8,4) NOT NULL DEFAULT 1.0 CHECK (max_balance_percent > 0 AND max_balance_percent <= 5),
  max_session_loss       numeric(20,8) NOT NULL DEFAULT 5.0 CHECK (max_session_loss > 0),
  max_daily_loss         numeric(20,8) NOT NULL DEFAULT 5.0 CHECK (max_daily_loss > 0),
  max_drawdown_percent   numeric(8,4) NOT NULL DEFAULT 5.0 CHECK (max_drawdown_percent > 0 AND max_drawdown_percent <= 25),
  max_consecutive_losses integer NOT NULL DEFAULT 3 CHECK (max_consecutive_losses BETWEEN 1 AND 10),
  max_open_contracts     integer NOT NULL DEFAULT 1 CHECK (max_open_contracts BETWEEN 1 AND 5),
  attempts_used_session  integer NOT NULL DEFAULT 0 CHECK (attempts_used_session >= 0),
  session_realized_pnl   numeric(20,8) NOT NULL DEFAULT 0,
  consecutive_losses     integer NOT NULL DEFAULT 0,
  cooldown_until         timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bounded_recovery_policies(policy_id) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
