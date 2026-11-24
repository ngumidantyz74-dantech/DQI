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

export interface RankedSignal {
  symbol: string;
  symbolLabel: string;
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  digit: number;
  score: number;
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

function zScoreForDigit(count: number, total: number): number {
  if (total <= 0) return 0;
  const expected = total * 0.1;
  const sd = Math.sqrt(total * 0.1 * 0.9);
  if (sd <= 0) return 0;
  return (count - expected) / sd;
}

function wilsonLowerPct(k: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return Math.max(0, center - margin) * 100;
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

  // Real Deriv break-even probabilities (or accurate fallback until proposal arrives)
  const matchBePct =
    matchProposal && matchProposal.payout > 0
      ? (matchProposal.askPrice / matchProposal.payout) * 100
      : 11.3;
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

    // 1. DIGITDIFF (DiffersScalper Engine)
    if (filter === 'BEST' || filter === 'DIGITDIFF') {
      const differRate100 = 100 - pctMed;
      const differRateLong = 100 - pctLong;
      const blendedDifferRate = differRate100 * 0.65 + differRateLong * 0.35;
      const edgePct = blendedDifferRate - differBePct;
      const compCiLow = wilsonLowerPct(medN - medCounts[digit], medN);

      const checkSample = n >= 100;
      const checkMedCold = pctMed <= 6.5;
      const checkLongSafe = pctLong <= 10.2;
      const checkMicroQuiet = microCnt <= 1 && digit !== latestDigit;
      const checkMarkovLow = latestFromTotal < 8 || transPct <= 9.5;
      const checkEdge = edgePct >= 1.5;
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
          label: 'Beats Break-Even',
          passed: checkEdge && checkVol,
          detail: `${blendedDifferRate.toFixed(1)}% vs ${differBePct.toFixed(1)}% BE`,
        },
      ];

      const passedCount = checks.filter((c) => c.passed).length;
      const entryReady =
        checkSample &&
        checkMedCold &&
        checkLongSafe &&
        checkMicroQuiet &&
        checkMarkovLow &&
        checkEdge &&
        checkVol;

      const rawScore =
        50 +
        Math.max(-12, (10 - pctMed) * 3.8) +
        Math.max(-6, (10 - pctLong) * 2.2) +
        (microCnt === 0 ? 7 : microCnt === 1 ? 2 : -10) +
        (digit === latestDigit ? -12 : 3) +
        Math.max(-8, (10 - transPct) * 0.9) +
        (compCiLow >= differBePct - 1.5 ? 4 : 0) -
        highVolPenalty;

      const clampedScore = Math.max(15, Math.min(96, Math.round(rawScore)));
      const finalScore = entryReady ? Math.max(80, clampedScore) : Math.min(76, clampedScore);
      const gateStatus: GateStatus = entryReady
        ? 'ENTRY_READY'
        : passedCount >= 4 && finalScore >= 68
        ? 'WATCH'
        : 'WAIT_NO_EDGE';

      results.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITDIFF',
        digit,
        score: finalScore,
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
        edgePct: Number(edgePct.toFixed(1)),
        lastSeenTicksAgo: gap,
        payout: differProposal?.payout ?? null,
        askPrice: differProposal?.askPrice ?? null,
        sampleCount: n,
        checks,
        reason: entryReady
          ? `Differ ${digit}: ${differRate100.toFixed(1)}% avoid in 100t (${pctLong.toFixed(1)}% in ${longN}t), ${microCnt} hit(s) in 25t, ${transPct.toFixed(0)}% after ${latestDigit}`
          : `WAIT on Differ ${digit}: ${passedCount}/5 checks passed (${pctMed.toFixed(1)}% 100t · ${microCnt}/25 micro · edge ${edgePct >= 0 ? '+' : ''}${edgePct.toFixed(1)}%)`,
      });
    }

    // 2. DIGITMATCH (MatchesScalper Engine)
    if (filter === 'BEST' || filter === 'DIGITMATCH') {
      const blendedMatchRate = pctMed * 0.65 + pctLong * 0.35;
      const edgePct = blendedMatchRate - matchBePct;

      const checkSample = n >= 100;
      const checkMedHot = pctMed >= 14.0 && zMed >= 1.1;
      const checkLongBias = pctLong >= 11.2 && zLong >= 0.85;
      const checkLiveTrigger =
        microCnt >= 3 || (latestFromTotal >= 8 && transPct >= 16.0);
      const checkCadence = gap >= 1 && gap <= 9;
      const checkEdge = edgePct >= 1.5 && !extremeVol;

      const checks = [
        {
          label: '100t Hot Digit',
          passed: checkMedHot,
          detail: `${pctMed.toFixed(1)}% hit (z=${zMed.toFixed(2)})`,
        },
        {
          label: `${longN}t Trend`,
          passed: checkLongBias,
          detail: `${pctLong.toFixed(1)}% (z=${zLong.toFixed(2)})`,
        },
        {
          label: `Trigger / Markov (${latestDigit}→${digit})`,
          passed: checkLiveTrigger,
          detail: `${microCnt}/25 hits · ${transPct.toFixed(1)}% after ${latestDigit}`,
        },
        {
          label: 'Active Cadence',
          passed: checkCadence,
          detail: `Last seen ${gap} tick(s) ago`,
        },
        {
          label: 'Beats Break-Even',
          passed: checkEdge,
          detail: `${blendedMatchRate.toFixed(1)}% vs ${matchBePct.toFixed(1)}% BE`,
        },
      ];

      const passedCount = checks.filter((c) => c.passed).length;
      const entryReady =
        checkSample &&
        checkMedHot &&
        checkLongBias &&
        checkLiveTrigger &&
        checkCadence &&
        checkEdge;

      const rawScore =
        44 +
        Math.max(-10, (pctMed - 10) * 3.4) +
        Math.max(-6, (pctLong - 10) * 3.0) +
        Math.min(14, microCnt * 3.2) +
        (latestFromTotal >= 6 ? Math.max(-4, (transPct - 10) * 0.9) : 0) +
        (checkCadence ? 6 : -6) -
        highVolPenalty;

      const clampedScore = Math.max(15, Math.min(95, Math.round(rawScore)));
      const finalScore = entryReady ? Math.max(80, clampedScore) : Math.min(75, clampedScore);
      const gateStatus: GateStatus = entryReady
        ? 'ENTRY_READY'
        : passedCount >= 3 && finalScore >= 66
        ? 'WATCH'
        : 'WAIT_NO_EDGE';

      results.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITMATCH',
        digit,
        score: finalScore,
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
        edgePct: Number(edgePct.toFixed(1)),
        lastSeenTicksAgo: gap,
        payout: matchProposal?.payout ?? null,
        askPrice: matchProposal?.askPrice ?? null,
        sampleCount: n,
        checks,
        reason: entryReady
          ? `Match ${digit}: ${pctMed.toFixed(1)}% in 100t (${pctLong.toFixed(1)}% in ${longN}t, z=${zLong.toFixed(2)}), ${transPct.toFixed(0)}% after ${latestDigit}`
          : `WAIT on Match ${digit}: ${passedCount}/5 checks passed (${pctMed.toFixed(1)}% 100t · ${pctLong.toFixed(1)}% ${longN}t · ${microCnt}/25 micro)`,
      });
    }
  }

  // Always rank ENTRY_READY first, then highest score
  results.sort((a, b) => {
    if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
    return b.score - a.score;
  });

  return results;
}

/**
 * Zero-lookahead replay over the most recent real Deriv ticks:
 * Tests whether ENTRY_READY gated signals produced real net wins using live Deriv payout ratios.
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
        : 8.85
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
      winRatePct: 0,
      netPnlPerDollar: 0,
      contractType,
    };
  }

  let signalsTriggered = 0;
  let wins = 0;
  let losses = 0;
  let netPnl = 0;

  // Step every 2 ticks so evaluation stays sub-millisecond on every tick
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
      netPnl += netWinPerDollar;
    } else {
      losses += 1;
      netPnl -= 1;
    }
  }

  return {
    sampleTicks: ticks.length - startIdx,
    signalsTriggered,
    wins,
    losses,
    winRatePct: signalsTriggered > 0 ? Number(((wins / signalsTriggered) * 100).toFixed(1)) : 0,
    netPnlPerDollar: Number(netPnl.toFixed(2)),
    contractType,
  };
}
