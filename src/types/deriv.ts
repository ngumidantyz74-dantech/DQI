export type StrategyEngineType = 'digit_scalper' | 'reverse_martingale' | 'dalembert' | 'custom';

export type ContractCategory = 'digits' | 'accumulator' | 'callput';

export type PurchaseDirection = 'DIGITMATCH' | 'DIGITDIFF' | 'ACCU' | 'CALL' | 'PUT';

export interface DerivSymbolInfo {
  symbol: string;
  displayName: string;
  pipSize: number;
  baseSpot: number;
  tickIntervalMs: number;
  volatilityFactor: number;
}

export const DERIV_SYMBOLS: Record<string, DerivSymbolInfo> = {
  '1HZ10V': {
    symbol: '1HZ10V',
    displayName: 'Volatility 10 (1s) Index',
    pipSize: 2,
    baseSpot: 9756.43,
    tickIntervalMs: 1000,
    volatilityFactor: 0.28,
  },
  '1HZ100V': {
    symbol: '1HZ100V',
    displayName: 'Volatility 100 (1s) Index',
    pipSize: 2,
    baseSpot: 1482.65,
    tickIntervalMs: 1000,
    volatilityFactor: 1.45,
  },
  '1HZ25V': {
    symbol: '1HZ25V',
    displayName: 'Volatility 25 (1s) Index',
    pipSize: 2,
    baseSpot: 3120.40,
    tickIntervalMs: 1000,
    volatilityFactor: 0.52,
  },
  '1HZ50V': {
    symbol: '1HZ50V',
    displayName: 'Volatility 50 (1s) Index',
    pipSize: 2,
    baseSpot: 48210.15,
    tickIntervalMs: 1000,
    volatilityFactor: 18.5,
  },
  '1HZ75V': {
    symbol: '1HZ75V',
    displayName: 'Volatility 75 (1s) Index',
    pipSize: 2,
    baseSpot: 6412.80,
    tickIntervalMs: 1000,
    volatilityFactor: 2.2,
  },
  R_10: {
    symbol: 'R_10',
    displayName: 'Volatility 10 Index',
    pipSize: 3,
    baseSpot: 6542.125,
    tickIntervalMs: 2000,
    volatilityFactor: 0.35,
  },
  R_100: {
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    pipSize: 2,
    baseSpot: 1924.55,
    tickIntervalMs: 2000,
    volatilityFactor: 2.1,
  },
};

export interface BotBlockSummary {
  id: string;
  phase: 'Trade Definition' | 'Initialization' | 'Before Purchase' | 'During Purchase' | 'After Purchase' | 'Tick Analysis' | 'Procedure';
  name: string;
  detail: string;
}

export interface BotStrategyConfig {
  id: string;
  name: string;
  fileName: string;
  sourcePath?: string;
  description: string;
  engineType: StrategyEngineType;
  market: string;
  submarket: string;
  symbol: string;
  tradeTypeCategory: ContractCategory;
  tradeType: string;
  purchaseType: PurchaseDirection;
  candleInterval: number;
  duration: number;
  durationUnit: 't' | 's' | 'm';
  prediction: number;
  growthRate: number; // e.g., 0.02 for 2%
  takeProfit: number;
  takeProfitEnabled: boolean;
  sellByCountdown: boolean;
  tickCount: number;
  initialStake: number;
  profitThreshold: number;
  lossThreshold: number;
  useMaxStake: boolean;
  maxStake: number;
  // DigitScalper specific
  winStep: number;
  maxWinSteps: number;
  // Reverse Martingale specific
  multiplierSize: number;
  // D'Alembert specific
  changeInUnit: number;
  // Parsed XML metadata
  variables: string[];
  blocks: BotBlockSummary[];
  rawXml: string;
}

export interface LiveTick {
  epoch: number;
  quote: number;
  symbol: string;
  lastDigit: number;
  source: 'deriv-ws' | 'local-feed';
}

export interface ExecutedTrade {
  id: string;
  contractId: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  contractType: PurchaseDirection;
  buyPrice: number;
  payout: number;
  profit: number;
  isWin: boolean;
  entrySpot: number;
  exitSpot: number;
  barrier?: number;
  ticksHeld: number;
  prediction?: number;
  exitDigit?: number;
  timestamp: string;
  mode: 'paper' | 'deriv-live';
}

export interface BotJournalEntry {
  id: string;
  time: string;
  type: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface CsvTransaction {
  market: string;
  referenceIdBuy: string;
  referenceIdSell: string;
  barrier: number;
  startTime: string;
  entrySpot: number;
  entrySpotTime: string;
  exitSpot: number;
  exitSpotTime: string;
  buyPrice: number;
  profitLoss: number;
  isWin: boolean;
  cumulativeProfit: number;
  drawdown: number;
  spotDelta: number;
}

export interface CsvSummaryStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalVolume: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  maxWinStreak: number;
  maxLossStreak: number;
  avgProfitOnWin: number;
  avgLossOnLoss: number;
  markets: string[];
}

export interface DerivAccount {
  loginid: string;
  token: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  email?: string;
  fullname?: string;
}
