export type DqiTab = 'terminal' | 'digits' | 'scanner' | 'strategy' | 'risk';

export interface ActiveSymbol {
  symbol: string;
  display_name: string;
  market: string;
  market_display_name: string;
  submarket: string;
  submarket_display_name: string;
  pip: number;
  pip_size: number;
  exchange_is_open: number;
  is_trading_suspended: number;
}

export interface LiveTickEvent {
  symbol: string;
  epoch: number;
  rawQuote: string;
  quote: number;
  pipSize: number;
  lastDigit: number;
  receivedAt: string;
  source: string;
}

export interface CandleBar {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ContractSupport {
  symbol: string;
  supportedTypes: string[];
  supportsDigits: boolean;
  supportsMatch: boolean;
  supportsDiffer: boolean;
  supportsOverUnder: boolean;
  supportsEvenOdd: boolean;
  supportsRiseFall: boolean;
  minDurationTicks: number | null;
  maxDurationTicks: number | null;
  checkedAt: string;
}

export interface DigitStatRow {
  digit: number;
  count: number;
  percentage: number;
  deviationFrom10Pct: number;
  ciLowPct: number;
  ciHighPct: number;
  lastSeenTicksAgo: number | null;
  maxConsecutiveStreak: number;
}

export interface DigitAnalytics {
  symbol: string;
  windowSize: number;
  sampleCount: number;
  dataQuality: 'SUFFICIENT' | 'LOW_SAMPLE' | 'INSUFFICIENT_DATA';
  qualityNote: string;
  asOfEpoch: number | null;
  asOfTimestamp: string | null;
  latestObservedDigit: number | null;
  latestQuote: string | null;
  quotePrecision: number | null;
  digits: DigitStatRow[];
  evenCount: number;
  oddCount: number;
  evenPct: number;
  oddPct: number;
  over4Count: number;
  under5Count: number;
  over4Pct: number;
  under5Pct: number;
  currentStreakDigit: number | null;
  currentStreakLength: number;
  entropyBits: number;
  maxEntropyBits: number;
  chiSquareStat: number | null;
  chiSquareValid: boolean;
  chiSquareNote: string;
  historicalLeaders: Array<{ digit: number; percentage: number; count: number }>;
  recentLeaders: Array<{ digit: number; percentage: number; count: number }>;
  tape: Array<{ digit: number; quote: string; epoch: number; time: string }>;
  transitionHotPairs: Array<{ from: number; to: number; count: number; ratePct: number }>;
}

export interface TickVolatility {
  symbol: string;
  window: number;
  sampleCount: number;
  regime: 'VERY_LOW' | 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' | 'INSUFFICIENT_DATA';
  rawWindowVolBps: number | null;
  meanAbsReturnBps: number | null;
  rangePct: number | null;
  trendVsPrevious: 'EXPANDING' | 'CONTRACTING' | 'STABLE' | 'INSUFFICIENT_DATA';
  gapWarnings: number;
  staleSeconds: number | null;
  isStale: boolean;
  asOfTimestamp: string | null;
}

export interface MatchDifferCandidate {
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  barrierDigit: number;
  observedFrequencyPct: number;
  complementFrequencyPct: number;
  ciLowPct: number;
  ciHighPct: number;
  sampleCount: number;
  proposalAskPrice: number | null;
  proposalPayout: number | null;
  breakEvenProbPct: number | null;
  estimatedEv: number | null;
  volatilityRegime: string;
  modelVersion: string;
  status: 'NO_VALIDATED_EDGE' | 'INSUFFICIENT_DATA' | 'POTENTIAL_RESEARCH_CANDIDATE';
  reason: string;
}

export interface DigitsFullResponse {
  analytics: DigitAnalytics;
  volatility: TickVolatility;
  contractSupport: ContractSupport;
  proposals: {
    match: { askPrice: number; payout: number } | null;
    differ: { askPrice: number; payout: number } | null;
    stake: number;
    durationTicks: number;
  };
  matchCandidates: MatchDifferCandidate[];
  differCandidates: MatchDifferCandidate[];
  feedHealth: {
    connectionState: string;
    isConnected: boolean;
    isStale: boolean;
    ageSeconds: number | null;
    lastMessageAt: string | null;
  };
}

export interface QuantAnalysis {
  symbol: string;
  timeframe: string;
  as_of_epoch: number;
  price: number;
  direction: 'BUY' | 'SELL' | 'NEUTRAL';
  raw_confidence: number;
  calibrated_confidence: number;
  calibration_status: 'EMPIRICALLY_FITTED' | 'UNTRAINED_RAW_SCORE';
  score: number;
  regime: string;
  regime_strength: number;
  invalidation_level: number | null;
  model_version: string;
  indicators: {
    sma20: number | null;
    ema12: number | null;
    ema26: number | null;
    rsi14: number | null;
    atr14: number | null;
    adx14: number | null;
    cci20: number | null;
    stochastic: { k: number; d: number } | null;
    donchian20: { upper: number; lower: number; middle: number } | null;
    bollinger: { middle: number; upper: number; lower: number; bandwidth: number } | null;
    macd: { macd: number; signal: number; histogram: number } | null;
    realized_volatility_20: number | null;
    support: number | null;
    resistance: number | null;
  };
  reasons: string[];
  sample_size: number;
}

export interface PaperAccount {
  paper_account_id: number;
  account_name: string;
  currency: string;
  starting_equity: number;
  current_equity: number;
  reserved_stake: number;
  available_balance: number;
  execution: 'PAPER_ONLY';
  metrics: {
    closed_trades: number;
    open_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    net_profit: number;
    profit_factor: number | string;
    max_drawdown: number;
  };
}

export interface PaperPosition {
  position_id: number;
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
}

export interface PaperStrategy {
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
