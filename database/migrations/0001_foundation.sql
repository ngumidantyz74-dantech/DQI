CREATE TABLE IF NOT EXISTS schema_migrations (
    version       varchar(255) PRIMARY KEY,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    checksum      varchar(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS app_users (
    user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         varchar(320) NOT NULL UNIQUE,
    display_name  varchar(120),
    status        varchar(20) NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'DISABLED', 'PENDING')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trading_accounts (
    account_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id    uuid REFERENCES app_users(user_id) ON DELETE RESTRICT,
    provider         varchar(30) NOT NULL CHECK (provider IN ('DERIV_OPTIONS', 'DERIV_MT5')),
    environment      varchar(10) NOT NULL CHECK (environment IN ('DEMO', 'REAL')),
    external_ref     varchar(128),
    currency         varchar(12),
    display_label    varchar(120),
    status           varchar(20) NOT NULL DEFAULT 'DISCONNECTED'
                     CHECK (status IN ('DISCONNECTED', 'CONNECTED', 'SUSPENDED')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, environment, external_ref)
);

CREATE TABLE IF NOT EXISTS market_symbols (
    symbol_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider         varchar(30) NOT NULL,
    symbol_code      varchar(80) NOT NULL,
    display_name     varchar(160) NOT NULL,
    market_category  varchar(80),
    is_active        boolean NOT NULL DEFAULT true,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    discovered_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, symbol_code)
);

CREATE TABLE IF NOT EXISTS strategies (
    strategy_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             varchar(120) NOT NULL,
    description      text,
    status           varchar(20) NOT NULL DEFAULT 'RESEARCH'
                     CHECK (status IN ('RESEARCH', 'PAPER', 'APPROVED', 'DISABLED')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_versions (
    strategy_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id         uuid NOT NULL REFERENCES strategies(strategy_id) ON DELETE RESTRICT,
    version              varchar(40) NOT NULL,
    configuration        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (strategy_id, version)
);

CREATE TABLE IF NOT EXISTS signals (
    signal_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_version_id uuid REFERENCES strategy_versions(strategy_version_id),
    provider           varchar(30) NOT NULL,
    symbol_code        varchar(80) NOT NULL,
    direction          varchar(12) NOT NULL CHECK (direction IN ('BUY', 'SELL', 'CALL', 'PUT', 'NEUTRAL')),
    timeframe          varchar(20),
    confidence         numeric(8,7) CHECK (confidence BETWEEN 0 AND 1),
    expected_value     numeric(20,8),
    market_regime      varchar(40),
    status             varchar(24) NOT NULL DEFAULT 'PENDING_REVIEW',
    features           jsonb NOT NULL DEFAULT '{}'::jsonb,
    model_version      varchar(80),
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_events (
    risk_event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        uuid REFERENCES trading_accounts(account_id),
    severity          varchar(12) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    event_code        varchar(80) NOT NULL,
    message           text NOT NULL,
    details           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    audit_id          bigserial PRIMARY KEY,
    actor_user_id     uuid REFERENCES app_users(user_id),
    action            varchar(100) NOT NULL,
    resource_type     varchar(80) NOT NULL,
    resource_id       varchar(128),
    request_id        varchar(128),
    outcome           varchar(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals(symbol_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_created_at ON risk_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_symbols_provider_active ON market_symbols(provider, is_active);
