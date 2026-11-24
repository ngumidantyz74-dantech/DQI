export type StrategyFilter = 'BEST' | 'DIGITMATCH' | 'DIGITDIFF';
export type GateStatus = 'ENTRY_READY' | 'WATCH' | 'WAIT_NO_EDGE';

export interface SimpleTick {
  digit: number;
  quote: string;
  epoch: number;
}

export interface LiveProposalQuote {
  askPrice: number;
  payout: number;
}

export interface DigitDistributionStats {
  sampleCount: number;
  chiSquare: number;
  regimeLabel: 'RANDOM_UNIFORM' | 'SKEWED_SAMPLE';
  maxDeviationPct: number;
}

export interface RankedSignal {
  symbol: string;
  symbolLabel: string;
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  digit: number;
  /** Sample activity / filter fit index (0–100), NOT future win probability */
  score: number;
  /** True theoretical single-tick probability on fair 0-9 ticks: 90% Differ / 10% Match */
  trueWinProbPct: number;
  strength: 'STRONG' | 'MODERATE' | 'WAIT';
  gateStatus: GateStatus;
  entryReady: boolean;
  observedPct: number;
  longWindowPct: number;
  microCount25: number;
  zScoreLong: number;
  transitionPct: number;
  transitionSamples: number;
  avoidPct: number;
  breakEvenPct: number;
  edgePct: number;
  chiSquare: number;
  lastSeenTicksAgo: number | null;
  payout: number | null;
  askPrice: number | null;
  sampleCount: number;
  checks: Array<{ label: string; passed: boolean; detail: string }>;
  reason: string;
}

export interface WalkForwardTickReplay {
  sampleTicks: number;
  signalsTriggered: number;
  wins: number;
  losses: number;
  maxLossStreak: number;
  winRatePct: number;
  netPnlPerDollar: number;
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
}

export function mergeUniqueTicks(
  base: SimpleTick[],
  live: SimpleTick[],
  maxTicks = 500
): SimpleTick[] {
  const seen = new Set<string>();
  const merged: SimpleTick[] = [];
  for (const item of [...base, ...live]) {
    if (!Number.isInteger(item.digit) || item.digit < 0 || item.digit > 9) continue;
    const key = `${item.epoch}:${item.quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  merged.sort((a, b) => a.epoch - b.epoch);
  return merged.slice(-maxTicks);
}

export function evaluateDigitDistributionStats(ticks: SimpleTick[]): DigitDistributionStats {
  const slice = ticks.slice(-500);
  const n = slice.length;
  if (n < 20) {
    return {
      sampleCount: n,
      chiSquare: 0,
      regimeLabel: 'RANDOM_UNIFORM',
      maxDeviationPct: 0,
    };
  }
  const counts = new Array<number>(10).fill(0);
  for (const t of slice) {
    if (t.digit >= 0 && t.digit <= 9) counts[t.digit] += 1;
  }
  const expected = n / 10;
  let chiSq = 0;
  let maxDev = 0;
  for (let d = 0; d < 10; d += 1) {
    chiSq += Math.pow(counts[d] - expected, 2) / expected;
    const dev = Math.abs((counts[d] / n) * 100 - 10);
    if (dev > maxDev) maxDev = dev;
  }
  // df = 9, p=0.05 critical value is 16.92
  return {
    sampleCount: n,
    chiSquare: Number(chiSq.toFixed(2)),
    regimeLabel: chiSq >= 16.92 ? 'SKEWED_SAMPLE' : 'RANDOM_UNIFORM',
    maxDeviationPct: Number(maxDev.toFixed(1)),
  };
}

function zScoreForDigit(count: number, total: number): number {
  if (total <= 0) return 0;
  const expected = total * 0.1;
  const sd = Math.sqrt(total * 0.1 * 0.9);
  if (sd <= 0) return 0;
  return (count - expected) / sd;
}

export function evaluateLiveDigitSignals(params: {
  symbol: string;
  symbolLabel: string;
  ticks: SimpleTick[];
  filter: StrategyFilter;
  volatilityRegime: string;
  matchProposal?: LiveProposalQuote | null;
  differProposal?: LiveProposalQuote | null;
}): RankedSignal[] {
  const { symbol, symbolLabel, ticks, filter, volatilityRegime, matchProposal, differProposal } =
    params;
  const n = ticks.length;
  if (n < 30) return [];

  const longSlice = ticks.slice(-500);
  const medSlice = ticks.slice(-100);
  const microSlice = ticks.slice(-25);

  const longN = longSlice.length;
  const medN = medSlice.length;
  const microN = microSlice.length;

  const latestDigit = ticks[n - 1].digit;
  const distStats = evaluateDigitDistributionStats(longSlice);

  const longCounts = new Array<number>(10).fill(0);
  const medCounts = new Array<number>(10).fill(0);
  const microCounts = new Array<number>(10).fill(0);
  const lastSeenIdx = new Array<number>(10).fill(-1);
  const transAfterLatest = new Array<number>(10).fill(0);
  let latestFromTotal = 0;

  for (let i = 0; i < longN; i += 1) {
    const d = longSlice[i].digit;
    longCounts[d] += 1;
    if (i > 0 && longSlice[i - 1].digit === latestDigit) {
      transAfterLatest[d] += 1;
      latestFromTotal += 1;
    }
  }

  for (let i = 0; i < medN; i += 1) {
    const d = medSlice[i].digit;
    medCounts[d] += 1;
    lastSeenIdx[d] = i;
  }

  for (let i = 0; i < microN; i += 1) {
    microCounts[microSlice[i].digit] += 1;
  }

  // Real Deriv break-even probabilities (with realistic Deriv defaults before proposal arrives)
  const matchBePct =
    matchProposal && matchProposal.payout > 0
      ? (matchProposal.askPrice / matchProposal.payout) * 100
      : 11.9;
  const differBePct =
    differProposal && differProposal.payout > 0
      ? (differProposal.askPrice / differProposal.payout) * 100
      : 91.2;

  const extremeVol = volatilityRegime === 'EXTREME';
  const highVolPenalty = volatilityRegime === 'EXTREME' ? 18 : volatilityRegime === 'HIGH' ? 5 : 0;

  const results: RankedSignal[] = [];

  for (let digit = 0; digit <= 9; digit += 1) {
    const pctLong = (longCounts[digit] / longN) * 100;
    const pctMed = (medCounts[digit] / medN) * 100;
    const zLong = zScoreForDigit(longCounts[digit], longN);
    const zMed = zScoreForDigit(medCounts[digit], medN);
    const microCnt = microCounts[digit];
    const gap = lastSeenIdx[digit] >= 0 ? medN - 1 - lastSeenIdx[digit] : medN;
    const transPct =
      latestFromTotal > 0 ? (transAfterLatest[digit] / latestFromTotal) * 100 : 10;

    // 1. DIGITDIFF (Cold-Digit Differ Engine — 90% True Per-Tick Hit Rate)
    if (filter === 'BEST' || filter === 'DIGITDIFF') {
      const differRate100 = 100 - pctMed;
      const differRateLong = 100 - pctLong;
      const blendedDifferRate = differRate100 * 0.65 + differRateLong * 0.35;
      const sampleVsBe = blendedDifferRate - differBePct;

      const checkSample = n >= 100;
      const checkMedCold = pctMed <= 7.0;
      const checkLongSafe = pctLong <= 10.2;
      const checkMicroQuiet = microCnt <= 1 && digit !== latestDigit;
      const checkMarkovLow = latestFromTotal < 8 || transPct <= 10.0;
      const checkVol = !extremeVol;

      const checks = [
        {
          label: '100t Cold Digit',
          passed: checkMedCold,
          detail: `${pctMed.toFixed(1)}% hit (${differRate100.toFixed(1)}% differ)`,
        },
        {
          label: `${longN}t Baseline`,
          passed: checkLongSafe,
          detail: `${pctLong.toFixed(1)}% (z=${zLong.toFixed(2)})`,
        },
        {
          label: '25t Micro Quiet',
          passed: checkMicroQuiet,
          detail: `${microCnt}/25 hits · last ${gap}t ago`,
        },
        {
          label: `Markov after ${latestDigit}`,
          passed: checkMarkovLow,
          detail:
            latestFromTotal > 0
              ? `${transPct.toFixed(1)}% (${transAfterLatest[digit]}/${latestFromTotal})`
              : 'Low sample',
        },
        {
          label: 'Sample vs Payout BE',
          passed: sampleVsBe >= 1.0 && checkVol,
          detail: `${blendedDifferRate.toFixed(1)}% sample vs ${differBePct.toFixed(1)}% BE`,
        },
      ];

      const passedCount = checks.filter((c) => c.passed).length;
      const entryReady =
        checkSample &&
        checkMedCold &&
        checkLongSafe &&
        checkMicroQuiet &&
        checkMarkovLow &&
        sampleVsBe >= 1.0 &&
        checkVol;

      const rawActivity =
        55 +
        Math.max(-14, (10 - pctMed) * 3.6) +
        Math.max(-8, (10 - pctLong) * 2.2) +
        (microCnt === 0 ? 8 : microCnt === 1 ? 2 : -10) +
        (digit === latestDigit ? -14 : 3) +
        Math.max(-8, (10 - transPct) * 0.8) -
        highVolPenalty;

      const clamped = Math.max(20, Math.min(95, Math.round(rawActivity)));
      const gateStatus: GateStatus = entryReady
        ? 'ENTRY_READY'
        : passedCount >= 4 && clamped >= 65
        ? 'WATCH'
        : 'WAIT_NO_EDGE';

      results.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITDIFF',
        digit,
        score: clamped,
        trueWinProbPct: 90.0,
        strength: entryReady ? 'STRONG' : gateStatus === 'WATCH' ? 'MODERATE' : 'WAIT',
        gateStatus,
        entryReady,
        observedPct: Number(pctMed.toFixed(1)),
        longWindowPct: Number(pctLong.toFixed(1)),
        microCount25: microCnt,
        zScoreLong: Number(zLong.toFixed(2)),
        transitionPct: Number(transPct.toFixed(1)),
        transitionSamples: latestFromTotal,
        avoidPct: Number(differRate100.toFixed(1)),
        breakEvenPct: Number(differBePct.toFixed(1)),
        edgePct: Number(sampleVsBe.toFixed(1)),
        chiSquare: distStats.chiSquare,
        lastSeenTicksAgo: gap,
        payout: differProposal?.payout ?? null,
        askPrice: differProposal?.askPrice ?? null,
        sampleCount: n,
        checks,
        reason: entryReady
          ? `Coldest Differ ${digit}: ${differRate100.toFixed(1)}% sample avoid (${microCnt}/25 micro). True win rate is 90% per tick — use burst cap & stop on 1st loss.`
          : `Standby Differ ${digit}: ${passedCount}/5 sample filters met (${pctMed.toFixed(1)}% 100t · ${microCnt}/25 micro).`,
      });
    }

    // 2. DIGITMATCH (Hot-Cluster Scanner — Honest 10% Single-Tick Base Odds)
    if (filter === 'BEST' || filter === 'DIGITMATCH') {
      const blendedMatchRate = pctMed * 0.65 + pctLong * 0.35;
      const sampleVsBe = blendedMatchRate - matchBePct;

      const checkSample = n >= 100;
      const checkMedHot = pctMed >= 15.0 && zMed >= 1.45;
      const checkLongBias = pctLong >= 11.4 && zLong >= 0.95;
      const checkLiveTrigger =
        microCnt >= 3 || (latestFromTotal >= 8 && transPct >= 18.0);
      const checkCadence = gap >= 1 && gap <= 8;
      const checkBeatsBe = sampleVsBe >= 2.0 && !extremeVol;

      const checks = [
        {
          label: '100t Hot Cluster',
          passed: checkMedHot,
          detail: `${pctMed.toFixed(1)}% hit (z=${zMed.toFixed(2)})`,
        },
        {
          label: `${longN}t Sample Skew`,
          passed: checkLongBias,
          detail: `${pctLong.toFixed(1)}% (z=${zLong.toFixed(2)})`,
        },
        {
          label: `Markov / Burst (${latestDigit}→${digit})`,
          passed: checkLiveTrigger,
          detail: `${microCnt}/25 hits · ${transPct.toFixed(1)}% after ${latestDigit}`,
        },
        {
          label: 'Active Cadence',
          passed: checkCadence,
          detail: `Last seen ${gap} tick(s) ago`,
        },
        {
          label: 'Sample vs Payout BE',
          passed: checkBeatsBe,
          detail: `${blendedMatchRate.toFixed(1)}% sample vs ${matchBePct.toFixed(1)}% BE`,
        },
      ];

      const passedCount = checks.filter((c) => c.passed).length;
      const entryReady =
        checkSample &&
        checkMedHot &&
        checkLongBias &&
        checkLiveTrigger &&
        checkCadence &&
        checkBeatsBe;

      const rawActivity =
        38 +
        Math.max(-10, (pctMed - 10) * 3.0) +
        Math.max(-6, (pctLong - 10) * 2.5) +
        Math.min(12, microCnt * 2.8) +
        (latestFromTotal >= 6 ? Math.max(-4, (transPct - 10) * 0.7) : 0) +
        (checkCadence ? 5 : -5) -
        highVolPenalty;

      // Never inflate Match score into misleading 85%+ confidence numbers
      const clamped = Math.max(12, Math.min(78, Math.round(rawActivity)));
      const gateStatus: GateStatus = entryReady
        ? 'ENTRY_READY'
        : passedCount >= 3 && clamped >= 56
        ? 'WATCH'
        : 'WAIT_NO_EDGE';

      results.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITMATCH',
        digit,
        score: clamped,
        trueWinProbPct: 10.0,
        strength: entryReady ? 'STRONG' : gateStatus === 'WATCH' ? 'MODERATE' : 'WAIT',
        gateStatus,
        entryReady,
        observedPct: Number(pctMed.toFixed(1)),
        longWindowPct: Number(pctLong.toFixed(1)),
        microCount25: microCnt,
        zScoreLong: Number(zLong.toFixed(2)),
        transitionPct: Number(transPct.toFixed(1)),
        transitionSamples: latestFromTotal,
        avoidPct: Number((100 - pctMed).toFixed(1)),
        breakEvenPct: Number(matchBePct.toFixed(1)),
        edgePct: Number(sampleVsBe.toFixed(1)),
        chiSquare: distStats.chiSquare,
        lastSeenTicksAgo: gap,
        payout: matchProposal?.payout ?? null,
        askPrice: matchProposal?.askPrice ?? null,
        sampleCount: n,
        checks,
        reason: entryReady
          ? `Hot Cluster Match ${digit}: ${pctMed.toFixed(1)}% in 100t (${microCnt}/25 micro). Warning: True hit odds are ~10% per tick (expect losing streaks; cap max misses at 3).`
          : `Standby Match ${digit}: ${passedCount}/5 cluster checks met (${pctMed.toFixed(1)}% 100t · ${pctLong.toFixed(1)}% ${longN}t · true odds 10%).`,
      });
    }
  }

  // Rank ENTRY_READY first, then prioritize safer 90% Differ setups in BEST mode, then activity score
  results.sort((a, b) => {
    if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
    if (filter === 'BEST' && a.trueWinProbPct !== b.trueWinProbPct) {
      return b.trueWinProbPct - a.trueWinProbPct;
    }
    return b.score - a.score;
  });

  return results;
}

/**
 * Zero-lookahead replay over the most recent real Deriv ticks:
 * Reports honest wins, losses, worst consecutive loss streak, and net P&L per $1 stake.
 */
export function runWalkForwardDigitReplay(params: {
  symbol: string;
  symbolLabel: string;
  ticks: SimpleTick[];
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  volatilityRegime: string;
  matchProposal?: LiveProposalQuote | null;
  differProposal?: LiveProposalQuote | null;
}): WalkForwardTickReplay {
  const {
    symbol,
    symbolLabel,
    ticks,
    contractType,
    volatilityRegime,
    matchProposal,
    differProposal,
  } = params;

  const payoutMultiplier =
    contractType === 'DIGITMATCH'
      ? matchProposal && matchProposal.askPrice > 0
        ? matchProposal.payout / matchProposal.askPrice
        : 8.4
      : differProposal && differProposal.askPrice > 0
      ? differProposal.payout / differProposal.askPrice
      : 1.095;

  const netWinPerDollar = payoutMultiplier - 1;
  const startIdx = Math.max(120, ticks.length - 120);
  if (ticks.length <= startIdx + 5) {
    return {
      sampleTicks: ticks.length,
      signalsTriggered: 0,
      wins: 0,
      losses: 0,
      maxLossStreak: 0,
      winRatePct: 0,
      netPnlPerDollar: 0,
      contractType,
    };
  }

  let signalsTriggered = 0;
  let wins = 0;
  let losses = 0;
  let curLossStreak = 0;
  let maxLossStreak = 0;
  let netPnl = 0;

  for (let i = startIdx; i < ticks.length - 1; i += 2) {
    const prefix = ticks.slice(Math.max(0, i - 350), i);
    const ranked = evaluateLiveDigitSignals({
      symbol,
      symbolLabel,
      ticks: prefix,
      filter: contractType,
      volatilityRegime,
      matchProposal,
      differProposal,
    });
    const top = ranked[0];
    if (!top || !top.entryReady) continue;

    signalsTriggered += 1;
    const actualNextDigit = ticks[i].digit;
    const isWin =
      contractType === 'DIGITMATCH'
        ? actualNextDigit === top.digit
        : actualNextDigit !== top.digit;
    if (isWin) {
      wins += 1;
      curLossStreak = 0;
      netPnl += netWinPerDollar;
    } else {
      losses += 1;
      curLossStreak += 1;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
      netPnl -= 1;
    }
  }

  return {
    sampleTicks: ticks.length - startIdx,
    signalsTriggered,
    wins,
    losses,
    maxLossStreak,
    winRatePct: signalsTriggered > 0 ? Number(((wins / signalsTriggered) * 100).toFixed(1)) : 0,
    netPnlPerDollar: Number(netPnl.toFixed(2)),
    contractType,
  };
}
