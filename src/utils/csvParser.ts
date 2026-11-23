import { BotStrategyConfig, CsvSummaryStats, CsvTransaction } from '../types/deriv';

export function parseDerivCsv(csvText: string): {
  transactions: CsvTransaction[];
  stats: CsvSummaryStats;
} {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return {
      transactions: [],
      stats: emptyStats(),
    };
  }

  // Deriv CSV is often newest-first; sort chronologically by Start Time so equity curve flows left->right naturally
  const parsedRows: Omit<CsvTransaction, 'cumulativeProfit' | 'drawdown' | 'spotDelta'>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < 11) continue;

    const market = cols[0];
    const referenceIdBuy = cols[1];
    const referenceIdSell = cols[2];
    const barrier = parseFloat(cols[3]) || 0;
    const startTime = cols[4];
    const entrySpot = parseFloat(cols[5]) || 0;
    const entrySpotTime = cols[6];
    const exitSpot = parseFloat(cols[7]) || 0;
    const exitSpotTime = cols[8];
    const buyPrice = parseFloat(cols[9]) || 0;
    const profitLoss = parseFloat(cols[10]) || 0;

    parsedRows.push({
      market,
      referenceIdBuy,
      referenceIdSell,
      barrier,
      startTime,
      entrySpot,
      entrySpotTime,
      exitSpot,
      exitSpotTime,
      buyPrice,
      profitLoss,
      isWin: profitLoss > 0,
    });
  }

  // Reverse/sort ascending by startTime
  parsedRows.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let totalVolume = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let curWinStreak = 0;
  let curLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  const marketSet = new Set<string>();

  const transactions: CsvTransaction[] = parsedRows.map((row) => {
    cumulative = Number((cumulative + row.profitLoss).toFixed(2));
    if (cumulative > peak) peak = cumulative;
    const drawdown = Number((cumulative - peak).toFixed(2));
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;

    totalVolume += row.buyPrice;
    marketSet.add(row.market);

    if (row.isWin) {
      wins++;
      grossProfit += row.profitLoss;
      curWinStreak++;
      curLossStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else {
      losses++;
      grossLoss += Math.abs(row.profitLoss);
      curLossStreak++;
      curWinStreak = 0;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    }

    return {
      ...row,
      cumulativeProfit: cumulative,
      drawdown,
      spotDelta: Number((row.exitSpot - row.entrySpot).toFixed(4)),
    };
  });

  const totalTrades = transactions.length;
  const netProfit = Number(cumulative.toFixed(2));

  return {
    transactions,
    stats: {
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(1)) : 0,
      totalVolume: Number(totalVolume.toFixed(2)),
      netProfit,
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99.9 : 0,
      expectancy: totalTrades > 0 ? Number((netProfit / totalTrades).toFixed(3)) : 0,
      maxDrawdown,
      maxWinStreak,
      maxLossStreak,
      avgProfitOnWin: wins > 0 ? Number((grossProfit / wins).toFixed(2)) : 0,
      avgLossOnLoss: losses > 0 ? Number((grossLoss / losses).toFixed(2)) : 0,
      markets: Array.from(marketSet),
    },
  };
}

export interface ReplayPoint {
  tradeIndex: number;
  time: string;
  stake: number;
  isWin: boolean;
  tradeProfit: number;
  cumulativeProfit: number;
  actualCumulative: number;
  stoppedReason?: string;
}

export function replayStrategyOnCsv(
  transactions: CsvTransaction[],
  strategy: BotStrategyConfig,
  respectThresholds: boolean
): {
  points: ReplayPoint[];
  finalProfit: number;
  maxDrawdown: number;
  stoppedEarlyAt: number | null;
  stopReason: string | null;
} {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let stoppedEarlyAt: number | null = null;
  let stopReason: string | null = null;

  // Engine state
  let winStreak = 0;
  let multiplier = 1;
  let totalUnits = 1;

  const points: ReplayPoint[] = [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (stoppedEarlyAt !== null) {
      points.push({
        tradeIndex: i + 1,
        time: tx.startTime,
        stake: 0,
        isWin: tx.isWin,
        tradeProfit: 0,
        cumulativeProfit: cumulative,
        actualCumulative: tx.cumulativeProfit,
        stoppedReason: stopReason || undefined,
      });
      continue;
    }

    let stake = strategy.initialStake;
    if (strategy.engineType === 'digit_scalper') {
      stake = strategy.initialStake + winStreak * strategy.winStep;
    } else if (strategy.engineType === 'reverse_martingale') {
      stake = strategy.initialStake * multiplier;
    } else if (strategy.engineType === 'dalembert') {
      stake = strategy.initialStake * totalUnits;
    }

    if (strategy.useMaxStake && stake > strategy.maxStake) {
      stake = strategy.initialStake;
      multiplier = 1;
      totalUnits = 1;
    }
    stake = Number(stake.toFixed(2));

    // Calculate payout ratio from actual CSV trade (e.g. 0.90 / 1.00 = 0.90)
    const payoutRatio = tx.buyPrice > 0 && tx.isWin ? tx.profitLoss / tx.buyPrice : -1;
    const tradeProfit = Number((tx.isWin ? stake * payoutRatio : -stake).toFixed(2));

    cumulative = Number((cumulative + tradeProfit).toFixed(2));
    if (cumulative > peak) peak = cumulative;
    const dd = cumulative - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;

    // Update progression for next trade
    if (strategy.engineType === 'digit_scalper') {
      if (tx.isWin) {
        winStreak++;
        if (winStreak > strategy.maxWinSteps) winStreak = 0;
      } else {
        winStreak = 0;
      }
    } else if (strategy.engineType === 'reverse_martingale') {
      if (tx.isWin) {
        multiplier = multiplier * strategy.multiplierSize;
        if (strategy.useMaxStake && strategy.initialStake * multiplier > strategy.maxStake) {
          multiplier = 1;
        }
      } else {
        multiplier = 1;
      }
    } else if (strategy.engineType === 'dalembert') {
      if (tx.isWin) {
        totalUnits = Math.max(1, totalUnits - strategy.changeInUnit);
      } else {
        totalUnits = totalUnits + strategy.changeInUnit;
        if (strategy.useMaxStake && strategy.initialStake * totalUnits > strategy.maxStake) {
          totalUnits = 1;
        }
      }
    }

    if (respectThresholds) {
      if (cumulative >= strategy.profitThreshold) {
        stoppedEarlyAt = i + 1;
        stopReason = `Take Profit +$${strategy.profitThreshold.toFixed(2)} hit`;
      } else if (cumulative <= -strategy.lossThreshold) {
        stoppedEarlyAt = i + 1;
        stopReason = `Stop Loss -$${strategy.lossThreshold.toFixed(2)} hit`;
      }
    }

    points.push({
      tradeIndex: i + 1,
      time: tx.startTime,
      stake,
      isWin: tx.isWin,
      tradeProfit,
      cumulativeProfit: cumulative,
      actualCumulative: tx.cumulativeProfit,
      stoppedReason: stopReason || undefined,
    });
  }

  return {
    points,
    finalProfit: cumulative,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    stoppedEarlyAt,
    stopReason,
  };
}

function emptyStats(): CsvSummaryStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalVolume: 0,
    netProfit: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdown: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    avgProfitOnWin: 0,
    avgLossOnLoss: 0,
    markets: [],
  };
}
