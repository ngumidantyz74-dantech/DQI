BEGIN;
CREATE TABLE IF NOT EXISTS paper_accounts (
    paper_account_id bigserial PRIMARY KEY,
    account_name varchar(80) NOT NULL DEFAULT 'DQI Research Paper Account',
    currency varchar(8) NOT NULL DEFAULT 'USD',
    starting_equity numeric(20,8) NOT NULL CHECK(starting_equity > 0),
    current_equity numeric(20,8) NOT NULL CHECK(current_equity >= 0),
    reserved_stake numeric(20,8) NOT NULL DEFAULT 0 CHECK(reserved_stake >= 0),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_single_active_account ON paper_accounts(is_active) WHERE is_active=true;
CREATE TABLE IF NOT EXISTS paper_strategies (
    strategy_id bigserial PRIMARY KEY,
    name varchar(120) NOT NULL,
    description text NOT NULL DEFAULT '',
    symbol_code varchar(80),
    timeframe varchar(8) NOT NULL,
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paper_positions (
    position_id bigserial PRIMARY KEY,
    paper_account_id bigint NOT NULL REFERENCES paper_accounts(paper_account_id),
    strategy_id bigint REFERENCES paper_strategies(strategy_id),
    symbol_code varchar(80) NOT NULL,
    timeframe varchar(8) NOT NULL,
    direction varchar(8) NOT NULL CHECK(direction IN ('BUY','SELL')),
    stake numeric(20,8) NOT NULL CHECK(stake > 0),
    payout_multiplier numeric(12,6) NOT NULL CHECK(payout_multiplier > 0 AND payout_multiplier <= 10),
    entry_price numeric(24,12) NOT NULL CHECK(entry_price > 0),
    exit_price numeric(24,12),
    opened_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    settled_at timestamptz,
    status varchar(12) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','WON','LOST','CANCELLED')),
    profit_loss numeric(20,8),
    settlement jsonb,
    signal_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_account_status ON paper_positions(paper_account_id,status,opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol ON paper_positions(symbol_code,opened_at DESC);
CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
    snapshot_id bigserial PRIMARY KEY,
    paper_account_id bigint NOT NULL REFERENCES paper_accounts(paper_account_id),
    equity numeric(20,8) NOT NULL,
    reserved_stake numeric(20,8) NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paper_equity_history ON paper_equity_snapshots(paper_account_id,captured_at DESC);
CREATE TABLE IF NOT EXISTS paper_risk_events (
    risk_event_id bigserial PRIMARY KEY,
    paper_account_id bigint NOT NULL REFERENCES paper_accounts(paper_account_id),
    event_type varchar(40) NOT NULL,
    details jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
