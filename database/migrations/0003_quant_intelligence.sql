BEGIN;
CREATE TABLE IF NOT EXISTS quant_signals (
    signal_id bigserial PRIMARY KEY,
    provider varchar(20) NOT NULL DEFAULT 'DERIV',
    symbol_code varchar(80) NOT NULL,
    timeframe varchar(8) NOT NULL,
    direction varchar(12) NOT NULL CHECK(direction IN ('BUY','SELL','NEUTRAL')),
    raw_confidence numeric(8,6) NOT NULL CHECK(raw_confidence BETWEEN 0 AND 1),
    calibrated_confidence numeric(8,6) NOT NULL CHECK(calibrated_confidence BETWEEN 0 AND 1),
    score numeric(10,6) NOT NULL,
    regime varchar(40) NOT NULL,
    analysis jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quant_signals_symbol_time ON quant_signals(symbol_code,timeframe,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quant_signals_created ON quant_signals(created_at DESC);
CREATE TABLE IF NOT EXISTS quant_backtests (
    backtest_id bigserial PRIMARY KEY,
    symbol_code varchar(80) NOT NULL,
    timeframe varchar(8) NOT NULL,
    configuration jsonb NOT NULL,
    metrics jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quant_backtests_symbol_time ON quant_backtests(symbol_code,timeframe,created_at DESC);
CREATE TABLE IF NOT EXISTS quant_calibrations (
    calibration_id bigserial PRIMARY KEY,
    model_name varchar(80) NOT NULL,
    timeframe varchar(8) NOT NULL,
    slope numeric(12,6) NOT NULL CHECK(slope>0),
    intercept numeric(12,6) NOT NULL,
    sample_count integer NOT NULL CHECK(sample_count>=0),
    brier_score numeric(12,8),
    is_active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quant_active_calibration ON quant_calibrations(model_name,timeframe) WHERE is_active=true;
CREATE TABLE IF NOT EXISTS quant_walk_forward_runs (
    run_id bigserial PRIMARY KEY,
    symbol_code varchar(80) NOT NULL,
    timeframe varchar(8) NOT NULL,
    configuration jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
