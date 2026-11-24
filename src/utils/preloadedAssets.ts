import { BotStrategyConfig } from '../types/deriv';
import { parseDbotXml } from './xmlParser';

export interface PreloadedStrategyMeta {
  id: string;
  name: string;
  fileName: string;
  sourcePath: string;
  description: string;
}

export const PRELOADED_STRATEGIES: PreloadedStrategyMeta[] = [
  {
    id: 'differs-scalper',
    name: 'DiffersScalper 1s',
    fileName: 'DiffersScalper_3367f04a.xml',
    sourcePath: '/assets/aistudio/DiffersScalper_3367f04a.xml',
    description:
      'Linear win-streak DIGITDIFF scalper (Volatility 100 1s, +$0.25/win up to 3 steps, $5 TP / $5 SL). Upgraded in DQI with live cold-digit + Markov gating.',
  },
  {
    id: 'matches-scalper',
    name: 'MatchesScalper 1s',
    fileName: 'MatchesScalper_bca907ed.xml',
    sourcePath: '/assets/aistudio/MatchesScalper_bca907ed.xml',
    description:
      'Linear win-streak DIGITMATCH scalper (Volatility 100 1s, $0.50 base, +$0.25/win up to 2 steps, $5 TP / $4 SL). Upgraded in DQI with live hot-digit + transition gating.',
  },
  {
    id: 'digit-scalper',
    name: 'DigitScalper 1s',
    fileName: 'DigitScalper_3863aef1.xml',
    sourcePath: '/assets/aistudio/DigitScalper_3863aef1.xml',
    description:
      'Linear win-streak digit scalper on Volatility 100 (1s). Trades DIGITMATCH (digit 1) and steps stake by +$0.50 per consecutive win up to 3 steps.',
  },
  {
    id: 'reverse-martingale-accu',
    name: 'Reverse Martingale (Accumulator)',
    fileName: 'Reverse_Martingale__1__744a0bf2.xml',
    sourcePath: '/assets/aistudio/Reverse_Martingale__1__744a0bf2.xml',
    description:
      '2% Accumulator bot on Volatility 100 (1s) with $10 Take Profit. Doubles stake on winning contracts up to $20 Max Stake and resets to $3 on loss.',
  },
  {
    id: 'dalembert-accu',
    name: "D'Alembert (Accumulator)",
    fileName: 'D_Alembert_d00ec534.xml',
    sourcePath: '/assets/aistudio/D_Alembert_d00ec534.xml',
    description:
      "Balanced unit-step D'Alembert Accumulator (2% growth) on Volatility 100 (1s). Adds 1 unit after a loss and subtracts 1 unit after a win.",
  },
  {
    id: 'reverse-martingale-callput',
    name: 'Reverse Martingale (Rise/Fall)',
    fileName: 'Reverse_Martingale_3c4181cf.xml',
    sourcePath: '/assets/aistudio/Reverse_Martingale_3c4181cf.xml',
    description:
      '1-tick CALL Rise/Fall bot on Volatility 10 (1s) matching your CSV session profile ($1.00 base stake, $3 TP, $1 SL, $5 max stake).',
  },
];

export const PRELOADED_CSV_PATH = '/assets/aistudio/Transactions_2026-11-22_213354_cde1b4a2.csv';

export async function loadPreloadedStrategies(): Promise<BotStrategyConfig[]> {
  const results = await Promise.all(
    PRELOADED_STRATEGIES.map(async (meta) => {
      const res = await fetch(meta.sourcePath);
      if (!res.ok) {
        throw new Error(`Failed to load ${meta.fileName}`);
      }
      const xmlText = await res.text();
      return parseDbotXml(xmlText, meta);
    })
  );
  return results;
}

export async function loadPreloadedCsv(): Promise<string> {
  const res = await fetch(PRELOADED_CSV_PATH);
  if (!res.ok) {
    throw new Error('Failed to load preloaded Deriv transactions CSV');
  }
  return res.text();
}
