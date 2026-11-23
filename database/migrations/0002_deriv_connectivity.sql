ALTER TABLE trading_accounts
    ADD COLUMN IF NOT EXISTS account_type varchar(20),
    ADD COLUMN IF NOT EXISTS is_virtual boolean,
    ADD COLUMN IF NOT EXISTS broker_currency varchar(12),
    ADD COLUMN IF NOT EXISTS last_balance numeric(24, 8),
    ADD COLUMN IF NOT EXISTS last_balance_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

ALTER TABLE trading_accounts
    ADD CONSTRAINT trading_accounts_account_type_check
    CHECK (account_type IS NULL OR account_type IN ('STANDARD', 'VIRTUAL', 'CRYPTO', 'FINANCIAL', 'UNKNOWN'));

CREATE TABLE IF NOT EXISTS dqi_sessions (
    session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_token_hash varchar(64) NOT NULL UNIQUE,
    owner_user_id uuid NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    deriv_credential_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS deriv_oauth_transactions (
    transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES dqi_sessions(session_id) ON DELETE CASCADE,
    state_hash varchar(64) NOT NULL UNIQUE,
    encrypted_code_verifier text NOT NULL,
    redirect_uri text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS deriv_credentials (
    credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    provider varchar(20) NOT NULL DEFAULT 'DERIV',
    auth_method varchar(20) NOT NULL DEFAULT 'OAUTH2' CHECK (auth_method IN ('OAUTH2', 'PAT')),
    encrypted_access_token text NOT NULL,
    token_expires_at timestamptz NOT NULL,
    scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
    status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dqi_sessions
    ADD CONSTRAINT dqi_sessions_deriv_credential_fk
    FOREIGN KEY (deriv_credential_id) REFERENCES deriv_credentials(credential_id) ON DELETE SET NULL;

-- Bind every discovered broker account to the exact OAuth credential that discovered it.
ALTER TABLE trading_accounts
    ADD COLUMN deriv_credential_id uuid REFERENCES deriv_credentials(credential_id) ON DELETE CASCADE;

ALTER TABLE trading_accounts
    DROP CONSTRAINT IF EXISTS trading_accounts_provider_environment_external_ref_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_accounts_credential_environment
    ON trading_accounts(deriv_credential_id, provider, environment, external_ref);

CREATE TABLE IF NOT EXISTS market_ticks (
    tick_id bigserial PRIMARY KEY,
    provider varchar(20) NOT NULL DEFAULT 'DERIV',
    symbol_code varchar(80) NOT NULL,
    quote numeric(30, 12) NOT NULL,
    epoch bigint NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, symbol_code, epoch, quote)
);

CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_epoch
    ON market_ticks(symbol_code, epoch DESC);

CREATE TABLE IF NOT EXISTS account_balance_snapshots (
    snapshot_id bigserial PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES trading_accounts(account_id) ON DELETE CASCADE,
    balance numeric(24, 8) NOT NULL,
    currency varchar(12) NOT NULL,
    broker_epoch bigint,
    captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_time
    ON account_balance_snapshots(account_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS deriv_connection_events (
    event_id bigserial PRIMARY KEY,
    owner_user_id uuid REFERENCES app_users(user_id),
    account_id uuid REFERENCES trading_accounts(account_id),
    event_type varchar(60) NOT NULL,
    outcome varchar(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'INFO')),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- A single-operator bootstrap principal for this Phase 2 deployment.
-- Multi-user identity and role management will be introduced as a separate security phase.
INSERT INTO app_users(email, display_name, status)
VALUES ('dqi-operator@localhost', 'DQI Operator', 'ACTIVE')
ON CONFLICT (email) DO NOTHING;
