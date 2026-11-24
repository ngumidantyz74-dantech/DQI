export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface RawTick {
  symbol: string;
  epoch: number;
  rawQuote: string;
  quote: number;
  pipSize: number;
  lastDigit: number;
  receivedAt: string;
  source: string;
}

export const TIMEFRAMES: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

// ---------------- EXACT DIGIT EXTRACTION (DECIMAL-STRING SAFE) ----------------

export function formatQuoteWithPrecision(rawQuote: string | number, pipSize?: number): {
  rawQuote: string;
  quote: number;
  pipSize: number;
} {
  let str = typeof rawQuote === 'string' ? rawQuote.trim() : String(rawQuote);
  if (str.includes('e') || str.includes('E')) {
    const num = Number(str);
    if (!Number.isFinite(num)) throw new Error('Invalid non-finite quote');
    const precision = pipSize !== undefined && Number.isInteger(pipSize) && pipSize >= 0 ? pipSize : 4;
    str = num.toFixed(precision);
  }
  const num = Number(str);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid quote value: ${rawQuote}`);
  }

  const dotIdx = str.indexOf('.');
  const naturalDecimals = dotIdx >= 0 ? str.length - dotIdx - 1 : 0;
  const resolvedPrecision =
    pipSize !== undefined && Number.isInteger(pipSize) && pipSize >= 0
      ? pipSize
      : naturalDecimals;

  if (dotIdx >= 0 && naturalDecimals < resolvedPrecision) {
    str = str + '0'.repeat(resolvedPrecision - naturalDecimals);
  } else if (dotIdx < 0 && resolvedPrecision > 0) {
    str = str + '.' + '0'.repeat(resolvedPrecision);
  } else if (dotIdx >= 0 && naturalDecimals > resolvedPrecision && pipSize !== undefined) {
    // Truncate/round via string pad strictly when authoritative pipSize is smaller
    str = num.toFixed(resolvedPrecision);
  }

  return { rawQuote: str, quote: num, pipSize: resolvedPrecision };
}

export function extractExactLastDigit(rawQuote: string | number, pipSize?: number): {
  lastDigit: number;
  formattedQuote: string;
  pipSize: number;
} {
  const formatted = formatQuoteWithPrecision(rawQuote, pipSize);
  const digitsOnly = formatted.rawQuote.replace(/[^0-9]/g, '');
  if (!digitsOnly.length) {
    throw new Error(`Unable to extract digit from quote: ${rawQuote}`);
  }
  const lastChar = digitsOnly[digitsOnly.length - 1];
  const lastDigit = Number.parseInt(lastChar, 10);
  if (!Number.isInteger(lastDigit) || lastDigit < 0 || lastDigit > 9) {
    throw new Error(`Invalid extracted digit: ${lastChar}`);
  }
  return {
    lastDigit,
    formattedQuote: formatted.rawQuote,
    pipSize: formatted.pipSize,
  };
}

// ---------------- DIGITS INTELLIGENCE & STATISTICS ----------------

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

export interface DigitAnalyticsResult {
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

function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function analyzeDigitStream(symbol: string, ticks: RawTick[], requestedWindow = 100): DigitAnalyticsResult {
  const ordered = [...ticks].sort((a, b) => a.epoch - b.epoch);
  const windowSlice = ordered.slice(-Math.max(1, requestedWindow));
  const n = windowSlice.length;

  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const counts = new Array<number>(10).fill(0);
  const lastSeenIndex = new Array<number>(10).fill(-1);
  const maxStreaks = new Array<number>(10).fill(0);
  const curDigitRun = new Array<number>(10).fill(0);
  const transitions = Array.from({ length: 10 }, () => new Array<number>(10).fill(0));
  const fromTotals = new Array<number>(10).fill(0);

  let evenCount = 0;
  let over4Count = 0;
  let prevDigit: number | null = null;
  let streakDigit: number | null = null;
  let streakLen = 0;

  windowSlice.forEach((tick, idx) => {
    const d = tick.lastDigit;
    counts[d] += 1;
    lastSeenIndex[d] = idx;
    if (d % 2 === 0) evenCount += 1;
    if (d >= 5) over4Count += 1;

    if (prevDigit === d) {
      streakLen += 1;
    } else {
      streakDigit = d;
      streakLen = 1;
    }
    for (let x = 0; x < 10; x += 1) {
      if (x === d) {
        curDigitRun[x] += 1;
        if (curDigitRun[x] > maxStreaks[x]) maxStreaks[x] = curDigitRun[x];
      } else {
        curDigitRun[x] = 0;
      }
    }

    if (prevDigit !== null) {
      transitions[prevDigit][d] += 1;
      fromTotals[prevDigit] += 1;
    }
    prevDigit = d;
  });

  const oddCount = n - evenCount;
  const under5Count = n - over4Count;

  const digitRows: DigitStatRow[] = counts.map((count, digit) => {
    const pct = n > 0 ? (count / n) * 100 : 0;
    const ci = wilsonInterval(count, n);
    return {
      digit,
      count,
      percentage: Number(pct.toFixed(2)),
      deviationFrom10Pct: Number((pct - 10).toFixed(2)),
      ciLowPct: Number((ci.low * 100).toFixed(2)),
      ciHighPct: Number((ci.high * 100).toFixed(2)),
      lastSeenTicksAgo: lastSeenIndex[digit] >= 0 ? n - 1 - lastSeenIndex[digit] : null,
      maxConsecutiveStreak: maxStreaks[digit],
    };
  });

  // Shannon entropy (max log2(10) ≈ 3.3219 bits)
  let entropyBits = 0;
  if (n > 0) {
    for (const c of counts) {
      if (c > 0) {
        const p = c / n;
        entropyBits -= p * Math.log2(p);
      }
    }
  }

  // Chi-square goodness-of-fit against uniform 10% requires expected count >= 5 per cell => n >= 50
  const chiSquareValid = n >= 50;
  let chiSquareStat: number | null = null;
  if (chiSquareValid) {
    const expected = n / 10;
    let stat = 0;
    for (const c of counts) {
      stat += ((c - expected) ** 2) / expected;
    }
    chiSquareStat = Number(stat.toFixed(3));
  }

  // Recent slice (last min(50, n) ticks) vs Historical full window
  const recentWindow = ordered.slice(-Math.min(50, ordered.length));
  const recentCounts = new Array<number>(10).fill(0);
  for (const t of recentWindow) recentCounts[t.lastDigit] += 1;
  const recentN = recentWindow.length;

  const historicalLeaders = [...digitRows]
    .sort((a, b) => b.count - a.count || a.digit - b.digit)
    .map((r) => ({ digit: r.digit, percentage: r.percentage, count: r.count }));

  const recentLeaders = recentCounts
    .map((count, digit) => ({
      digit,
      count,
      percentage: recentN > 0 ? Number(((count / recentN) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.digit - b.digit);

  const transitionHotPairs: Array<{ from: number; to: number; count: number; ratePct: number }> = [];
  for (let i = 0; i < 10; i += 1) {
    if (fromTotals[i] < 3) continue;
    for (let j = 0; j < 10; j += 1) {
      if (transitions[i][j] >= 2) {
        transitionHotPairs.push({
          from: i,
          to: j,
          count: transitions[i][j],
          ratePct: Number(((transitions[i][j] / fromTotals[i]) * 100).toFixed(1)),
        });
      }
    }
  }
  transitionHotPairs.sort((a, b) => b.ratePct - a.ratePct || b.count - a.count);

  let dataQuality: 'SUFFICIENT' | 'LOW_SAMPLE' | 'INSUFFICIENT_DATA' = 'INSUFFICIENT_DATA';
  let qualityNote = 'Need at least 25 ticks before computing reliable frequency bars.';
  if (n >= 50) {
    dataQuality = 'SUFFICIENT';
    qualityNote = 'Descriptive historical stats only. Past frequencies do not predict future ticks.';
  } else if (n >= 25) {
    dataQuality = 'LOW_SAMPLE';
    qualityNote = 'Sample below 50 ticks — wide confidence intervals and Chi-square suppressed.';
  }

  const tape = ordered.slice(-500).map((t) => ({
    digit: t.lastDigit,
    quote: t.rawQuote,
    epoch: t.epoch,
    time: new Date(t.epoch * 1000).toISOString(),
  }));

  return {
    symbol,
    windowSize: requestedWindow,
    sampleCount: n,
    dataQuality,
    qualityNote,
    asOfEpoch: latest ? latest.epoch : null,
    asOfTimestamp: latest ? latest.receivedAt : null,
    latestObservedDigit: latest ? latest.lastDigit : null,
    latestQuote: latest ? latest.rawQuote : null,
    quotePrecision: latest ? latest.pipSize : null,
    digits: digitRows,
    evenCount,
    oddCount,
    evenPct: n > 0 ? Number(((evenCount / n) * 100).toFixed(2)) : 0,
    oddPct: n > 0 ? Number(((oddCount / n) * 100).toFixed(2)) : 0,
    over4Count,
    under5Count,
    over4Pct: n > 0 ? Number(((over4Count / n) * 100).toFixed(2)) : 0,
    under5Pct: n > 0 ? Number(((under5Count / n) * 100).toFixed(2)) : 0,
    currentStreakDigit: streakDigit,
    currentStreakLength: streakLen,
    entropyBits: Number(entropyBits.toFixed(4)),
    maxEntropyBits: 3.3219,
    chiSquareStat,
    chiSquareValid,
    chiSquareNote: chiSquareValid
      ? `χ²=${chiSquareStat?.toFixed(2)} (df=9; >16.92 indicates p<0.05 deviation in sample)`
      : 'Need >= 50 ticks for valid Chi-square test (expected >= 5 per digit)',
    historicalLeaders,
    recentLeaders,
    tape,
    transitionHotPairs: transitionHotPairs.slice(0, 8),
  };
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

export function evaluateMatchDifferCandidates(
  analytics: DigitAnalyticsResult,
  volatilityRegime: string,
  proposals: {
    match?: { askPrice: number; payout: number } | null;
    differ?: { askPrice: number; payout: number } | null;
  },
  safetyMargin = 0.015
): {
  matchCandidates: MatchDifferCandidate[];
  differCandidates: MatchDifferCandidate[];
} {
  const n = analytics.sampleCount;
  const matchCandidates: MatchDifferCandidate[] = [];
  const differCandidates: MatchDifferCandidate[] = [];

  for (const row of analytics.digits) {
    // DIGITMATCH
    const mAsk = proposals.match?.askPrice ?? null;
    const mPay = proposals.match?.payout ?? null;
    const mBe = mAsk && mPay && mPay > 0 ? mAsk / mPay : null;
    const pMatch = row.count / Math.max(1, n);
    const pMatchLower = row.ciLowPct / 100;
    const mEv = mAsk && mPay ? Number((pMatch * mPay - mAsk).toFixed(4)) : null;

    let mStatus: MatchDifferCandidate['status'] = 'NO_VALIDATED_EDGE';
    let mReason = 'No validated out-of-sample advantage over 10% uniform baseline.';
    if (n < 50) {
      mStatus = 'INSUFFICIENT_DATA';
      mReason = 'Minimum 50 ticks required for statistical confidence interval.';
    } else if (volatilityRegime === 'EXTREME') {
      mReason = 'Extreme volatility filter active — pause discretionary digit entries.';
    } else if (mBe !== null && pMatchLower > mBe + safetyMargin && n >= 250) {
      mStatus = 'POTENTIAL_RESEARCH_CANDIDATE';
      mReason = 'Lower confidence bound exceeds live proposal break-even (requires out-of-sample check).';
    } else if (mBe !== null) {
      mReason = `Observed lower bound (${row.ciLowPct.toFixed(1)}%) does not beat ${(mBe * 100).toFixed(1)}% break-even.`;
    }

    matchCandidates.push({
      contractType: 'DIGITMATCH',
      barrierDigit: row.digit,
      observedFrequencyPct: row.percentage,
      complementFrequencyPct: Number((100 - row.percentage).toFixed(2)),
      ciLowPct: row.ciLowPct,
      ciHighPct: row.ciHighPct,
      sampleCount: n,
      proposalAskPrice: mAsk,
      proposalPayout: mPay,
      breakEvenProbPct: mBe !== null ? Number((mBe * 100).toFixed(2)) : null,
      estimatedEv: mEv,
      volatilityRegime,
      modelVersion: 'dqi_digits_v1',
      status: mStatus,
      reason: mReason,
    });

    // DIGITDIFF
    const dAsk = proposals.differ?.askPrice ?? null;
    const dPay = proposals.differ?.payout ?? null;
    const dBe = dAsk && dPay && dPay > 0 ? dAsk / dPay : null;
    const compCount = Math.max(0, n - row.count);
    const compCi = wilsonInterval(compCount, n);
    const pDiff = compCount / Math.max(1, n);
    const dEv = dAsk && dPay ? Number((pDiff * dPay - dAsk).toFixed(4)) : null;

    let dStatus: MatchDifferCandidate['status'] = 'NO_VALIDATED_EDGE';
    let dReason = 'No trade — edge not established over break-even after safety margin.';
    if (n < 50) {
      dStatus = 'INSUFFICIENT_DATA';
      dReason = 'Minimum 50 ticks required for statistical confidence interval.';
    } else if (volatilityRegime === 'EXTREME') {
      dReason = 'Extreme volatility filter active — pause discretionary digit entries.';
    } else if (dBe !== null && compCi.low > dBe + safetyMargin && n >= 250) {
      dStatus = 'POTENTIAL_RESEARCH_CANDIDATE';
      dReason = 'Complement lower bound exceeds live proposal break-even (research check only).';
    } else if (dBe !== null) {
      dReason = `Complement lower bound (${(compCi.low * 100).toFixed(1)}%) below required ${((dBe + safetyMargin) * 100).toFixed(1)}% threshold.`;
    }

    differCandidates.push({
      contractType: 'DIGITDIFF',
      barrierDigit: row.digit,
      observedFrequencyPct: Number((100 - row.percentage).toFixed(2)),
      complementFrequencyPct: row.percentage,
      ciLowPct: Number((compCi.low * 100).toFixed(2)),
      ciHighPct: Number((compCi.high * 100).toFixed(2)),
      sampleCount: n,
      proposalAskPrice: dAsk,
      proposalPayout: dPay,
      breakEvenProbPct: dBe !== null ? Number((dBe * 100).toFixed(2)) : null,
      estimatedEv: dEv,
      volatilityRegime,
      modelVersion: 'dqi_digits_v1',
      status: dStatus,
      reason: dReason,
    });
  }

  return { matchCandidates, differCandidates };
}

// ---------------- VOLATILITY INTELLIGENCE ENGINE ----------------

export interface TickVolatilitySummary {
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

export function analyzeTickVolatility(symbol: string, ticks: RawTick[], window = 50): TickVolatilitySummary {
  const ordered = [...ticks].sort((a, b) => a.epoch - b.epoch);
  const latest = ordered[ordered.length - 1];
  const staleSeconds = latest ? Math.max(0, Math.floor((Date.now() - new Date(latest.receivedAt).getTime()) / 1000)) : null;
  const isStale = staleSeconds === null || staleSeconds > 15;

  if (ordered.length < 15) {
    return {
      symbol,
      window,
      sampleCount: ordered.length,
      regime: 'INSUFFICIENT_DATA',
      rawWindowVolBps: null,
      meanAbsReturnBps: null,
      rangePct: null,
      trendVsPrevious: 'INSUFFICIENT_DATA',
      gapWarnings: 0,
      staleSeconds,
      isStale,
      asOfTimestamp: latest?.receivedAt ?? null,
    };
  }

  const slice = ordered.slice(-Math.min(window, ordered.length));
  const returns: number[] = [];
  let gaps = 0;
  let minP = slice[0].quote;
  let maxP = slice[0].quote;

  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1];
    const curr = slice[i];
    minP = Math.min(minP, curr.quote);
    maxP = Math.max(maxP, curr.quote);
    if (curr.epoch - prev.epoch > 8) gaps += 1;
    if (prev.quote > 0) {
      returns.push((curr.quote - prev.quote) / prev.quote);
    }
  }

  const meanR = returns.reduce((s, r) => s + r, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / Math.max(1, returns.length - 1);
  const stdBps = Math.sqrt(variance) * 10000;
  const meanAbsBps = (returns.reduce((s, r) => s + Math.abs(r), 0) / Math.max(1, returns.length)) * 10000;
  const rangePct = minP > 0 ? ((maxP - minP) / minP) * 100 : 0;

  // Compare first half vs second half of slice for expansion/contraction
  const mid = Math.floor(returns.length / 2);
  const firstHalf = returns.slice(0, mid);
  const secondHalf = returns.slice(mid);
  const avgAbs1 = firstHalf.reduce((s, r) => s + Math.abs(r), 0) / Math.max(1, firstHalf.length);
  const avgAbs2 = secondHalf.reduce((s, r) => s + Math.abs(r), 0) / Math.max(1, secondHalf.length);

  let trend: TickVolatilitySummary['trendVsPrevious'] = 'STABLE';
  if (avgAbs1 > 0) {
    const ratio = avgAbs2 / avgAbs1;
    if (ratio >= 1.25) trend = 'EXPANDING';
    else if (ratio <= 0.8) trend = 'CONTRACTING';
  }

  // Adaptive per-tick classification in basis points
  let regime: TickVolatilitySummary['regime'] = 'NORMAL';
  if (stdBps < 1.2) regime = 'VERY_LOW';
  else if (stdBps < 3.0) regime = 'LOW';
  else if (stdBps < 8.5) regime = 'NORMAL';
  else if (stdBps < 18.0) regime = 'HIGH';
  else regime = 'EXTREME';

  return {
    symbol,
    window,
    sampleCount: slice.length,
    regime,
    rawWindowVolBps: Number(stdBps.toFixed(3)),
    meanAbsReturnBps: Number(meanAbsBps.toFixed(3)),
    rangePct: Number(rangePct.toFixed(4)),
    trendVsPrevious: trend,
    gapWarnings: gaps,
    staleSeconds,
    isStale,
    asOfTimestamp: latest?.receivedAt ?? null,
  };
}

// ---------------- TECHNICAL INDICATORS (DETERMINISTIC) ----------------

export function sma(values: number[], period: number): Array<number | null> {
  if (period < 1) throw new Error('SMA period must be positive');
  const out: Array<number | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Array<number | null> {
  if (period < 1) throw new Error('EMA period must be positive');
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 2 || values.length <= period) return out;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = avgLoss === 0 && avgGain > 0 ? 100 : avgLoss === 0 ? 50 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    out[i] = avgLoss === 0 && avgGain > 0 ? 100 : avgLoss === 0 ? 50 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function trueRanges(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: Candle[], period = 14): Array<number | null> {
  return ema(trueRanges(candles), period);
}

export function bollinger(values: number[], period = 20, deviations = 2.0) {
  const out: Array<{ middle: number; upper: number; lower: number; bandwidth: number } | null> = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    out[i] = {
      middle: mean,
      upper: mean + deviations * sd,
      lower: mean - deviations * sd,
      bandwidth: mean ? (4 * sd) / mean : 0,
    };
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const a = ema(values, fast);
  const b = ema(values, slow);
  const line = values.map((_, i) => (a[i] !== null && b[i] !== null ? (a[i] as number) - (b[i] as number) : null));
  const validStart = line.findIndex((x) => x !== null);
  const out: Array<{ macd: number; signal: number; histogram: number } | null> = new Array(values.length).fill(null);
  if (validStart < 0) return out;
  const compact = line.slice(validStart).filter((x): x is number => x !== null);
  const sig = ema(compact, signalPeriod);
  for (let j = 0; j < compact.length; j += 1) {
    const s = sig[j];
    if (s !== null) {
      out[validStart + j] = {
        macd: compact[j],
        signal: s,
        histogram: compact[j] - s,
      };
    }
  }
  return out;
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3) {
  const kLine: Array<number | null> = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i += 1) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      highest = Math.max(highest, candles[j].high);
      lowest = Math.min(lowest, candles[j].low);
    }
    const span = highest - lowest;
    kLine[i] = span > 0 ? ((candles[i].close - lowest) / span) * 100 : 50;
  }
  const dValues = sma(
    kLine.map((v) => v ?? 50),
    dPeriod
  );
  return candles.map((_, i) =>
    kLine[i] !== null && dValues[i] !== null
      ? { k: Number((kLine[i] as number).toFixed(2)), d: Number((dValues[i] as number).toFixed(2)) }
      : null
  );
}

export function adx(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2) return null;
  const trs = trueRanges(candles);
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const smoothTr = ema(trs, period);
  const smoothPlus = ema(plusDm, period);
  const smoothMinus = ema(minusDm, period);
  const dxList: number[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const trv = smoothTr[i];
    const pv = smoothPlus[i];
    const mv = smoothMinus[i];
    if (!trv || pv === null || mv === null) continue;
    const pdi = (100 * pv) / trv;
    const mdi = (100 * mv) / trv;
    const sum = pdi + mdi;
    dxList.push(sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0);
  }
  if (!dxList.length) return null;
  const recent = dxList.slice(-period);
  return Number((recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(2));
}

export function cci(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const tp = slice.map((c) => (c.high + c.low + c.close) / 3);
  const meanTp = tp.reduce((a, b) => a + b, 0) / period;
  const meanDev = tp.reduce((a, v) => a + Math.abs(v - meanTp), 0) / period;
  if (meanDev === 0) return 0;
  return Number(((tp[tp.length - 1] - meanTp) / (0.015 * meanDev)).toFixed(2));
}

export function donchian(candles: Candle[], period = 20) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const upper = Math.max(...slice.map((c) => c.high));
  const lower = Math.min(...slice.map((c) => c.low));
  return { upper, lower, middle: (upper + lower) / 2 };
}

export function realizedVolatility(values: number[], period = 20): number | null {
  if (values.length <= period) return null;
  const returns: number[] = [];
  for (let i = values.length - period + 1; i < values.length; i += 1) {
    if (values[i - 1] !== 0) returns.push(values[i] / values[i - 1] - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(period);
}

// ---------------- ANALYSIS, REGIMES & CALIBRATION ----------------

export interface QuantAnalysisResult {
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

function detectRegime(
  closes: number[],
  atrValues: Array<number | null>,
  bbValues: ReturnType<typeof bollinger>
): { regime: string; strength: number } {
  if (closes.length < 30) return { regime: 'INSUFFICIENT_DATA', strength: 0 };
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const f = fast[fast.length - 1];
  const s = slow[slow.length - 1];
  const vol = realizedVolatility(closes, 20) ?? 0;
  const bw = bbValues[bbValues.length - 1]?.bandwidth ?? 0;
  const lastAtr = atrValues[atrValues.length - 1] ?? 0;
  const lastClose = closes[closes.length - 1];
  const trend = f !== null && s ? Math.abs((f - s) / s) : 0;

  if (vol > 0.025 || (lastClose > 0 && lastAtr / lastClose > 0.02)) {
    return { regime: 'HIGH_VOLATILITY', strength: Math.min(1, vol * 20) };
  }
  if (trend > 0.0015 && f !== null && s !== null) {
    return { regime: f > s ? 'TREND_UP' : 'TREND_DOWN', strength: Math.min(1, trend * 200) };
  }
  if (bw < 0.003) {
    return { regime: 'LOW_VOLATILITY_RANGE', strength: Math.max(0, 1 - bw * 200) };
  }
  return { regime: 'RANGE', strength: Math.max(0, 1 - trend * 200) };
}

export function calibrateConfidence(raw: number, calibration?: { slope: number; intercept: number } | null): number {
  if (raw < 0 || raw > 1) throw new Error('Confidence must be between 0 and 1');
  if (!calibration) return Number(raw.toFixed(4));
  if (calibration.slope <= 0) throw new Error('Calibration slope must be positive');
  const x = Math.max(1e-6, Math.min(1 - 1e-6, raw));
  const z = Math.max(-30, Math.min(30, calibration.slope * Math.log(x / (1 - x)) + calibration.intercept));
  return Number((1 / (1 + Math.exp(-z))).toFixed(4));
}

export function fitPlattCalibration(observations: Array<{ confidence: number; outcome: number }>, maxIterations = 100) {
  if (observations.length < 30) throw new Error('At least 30 labelled outcomes are required');
  const xs: number[] = [];
  const ys: number[] = [];
  for (const item of observations) {
    if (!(item.confidence > 0 && item.confidence < 1) || (item.outcome !== 0 && item.outcome !== 1)) {
      throw new Error('Observations require confidence in (0, 1) and outcome 0 or 1');
    }
    xs.push(Math.log(item.confidence / (1 - item.confidence)));
    ys.push(item.outcome);
  }
  if (new Set(ys).size < 2) throw new Error('Calibration requires both winning and losing outcomes');

  let slope = 1.0;
  let intercept = 0.0;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const z = Math.max(-30, Math.min(30, slope * xs[i] + intercept));
      const q = 1 / (1 + Math.exp(-z));
      const w = Math.max(q * (1 - q), 1e-8);
      const err = q - ys[i];
      g0 += err * xs[i];
      g1 += err;
      h00 += w * xs[i] * xs[i];
      h01 += w * xs[i];
      h11 += w;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (-h01 * g0 + h00 * g1) / det;
    slope = Math.max(0.01, Math.min(20, slope - d0));
    intercept = Math.max(-20, Math.min(20, intercept - d1));
    if (Math.abs(d0) + Math.abs(d1) < 1e-7) break;
  }

  const predictions = xs.map((x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, slope * x + intercept)))));
  const brier = predictions.reduce((acc, p, i) => acc + (p - ys[i]) ** 2, 0) / xs.length;
  return {
    slope: Number(slope.toFixed(8)),
    intercept: Number(intercept.toFixed(8)),
    sample_count: xs.length,
    brier_score: Number(brier.toFixed(8)),
  };
}

export function analyzeCandles(
  symbol: string,
  timeframe: string,
  rawCandles: Candle[],
  calibration?: { slope: number; intercept: number } | null
): QuantAnalysisResult {
  if (!TIMEFRAMES[timeframe]) throw new Error('Unsupported timeframe');
  if (rawCandles.length < 35) throw new Error('At least 35 candles are required');
  const candles = [...rawCandles].sort((a, b) => a.epoch - b.epoch);
  for (const c of candles) {
    if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      throw new Error('Invalid OHLC candle');
    }
  }

  const closes = candles.map((c) => c.close);
  const s20 = sma(closes, 20);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const b = bollinger(closes, 20, 2);
  const m = macd(closes, 12, 26, 9);
  const st = stochastic(candles, 14, 3);
  const adxVal = adx(candles, 14);
  const cciVal = cci(candles, 20);
  const dc20 = donchian(candles, 20);
  const rVol = realizedVolatility(closes, 20);

  const { regime, strength } = detectRegime(closes, a, b);
  const last = closes[closes.length - 1];
  const lastE12 = e12[e12.length - 1];
  const lastE26 = e26[e26.length - 1];
  const lastR = r[r.length - 1];
  const lastB = b[b.length - 1];
  const lastM = m[m.length - 1];
  const lastAtr = a[a.length - 1];

  let score = 0;
  const reasons: string[] = [];

  if (lastE12 !== null && lastE26 !== null) {
    if (lastE12 > lastE26) {
      score += 0.3;
      reasons.push('EMA12 above EMA26');
    } else {
      score -= 0.3;
      reasons.push('EMA12 below EMA26');
    }
  }
  if (lastR !== null) {
    if (lastR > 55) {
      score += 0.2;
      reasons.push(`RSI bullish (${lastR.toFixed(1)})`);
    } else if (lastR < 45) {
      score -= 0.2;
      reasons.push(`RSI bearish (${lastR.toFixed(1)})`);
    }
  }
  if (lastM) {
    if (lastM.histogram > 0) {
      score += 0.2;
      reasons.push('MACD positive histogram');
    } else {
      score -= 0.2;
      reasons.push('MACD negative histogram');
    }
  }
  if (lastB) {
    if (last > lastB.middle) {
      score += 0.15;
      reasons.push('Price above Bollinger midline');
    } else {
      score -= 0.15;
      reasons.push('Price below Bollinger midline');
    }
  }

  if (regime === 'HIGH_VOLATILITY' || regime === 'INSUFFICIENT_DATA') {
    score *= 0.5;
  }

  const direction: 'BUY' | 'SELL' | 'NEUTRAL' = score >= 0.35 ? 'BUY' : score <= -0.35 ? 'SELL' : 'NEUTRAL';
  const rawConfidence = Math.min(0.9, 0.5 + Math.abs(score) * 0.35 + strength * 0.1);
  const calibrated = calibrateConfidence(rawConfidence, calibration);
  const invalidation =
    lastAtr && direction !== 'NEUTRAL'
      ? Number((direction === 'BUY' ? last - lastAtr * 1.5 : last + lastAtr * 1.5).toFixed(5))
      : null;

  return {
    symbol,
    timeframe,
    as_of_epoch: candles[candles.length - 1].epoch,
    price: last,
    direction,
    raw_confidence: Number(rawConfidence.toFixed(4)),
    calibrated_confidence: calibrated,
    calibration_status: calibration ? 'EMPIRICALLY_FITTED' : 'UNTRAINED_RAW_SCORE',
    score: Number(score.toFixed(4)),
    regime,
    regime_strength: Number(strength.toFixed(4)),
    invalidation_level: invalidation,
    model_version: 'dqi_signal_v1',
    indicators: {
      sma20: s20[s20.length - 1],
      ema12: lastE12,
      ema26: lastE26,
      rsi14: lastR,
      atr14: lastAtr,
      adx14: adxVal,
      cci20: cciVal,
      stochastic: st[st.length - 1],
      donchian20: dc20,
      bollinger: lastB,
      macd: lastM,
      realized_volatility_20: rVol,
      support: dc20?.lower ?? null,
      resistance: dc20?.upper ?? null,
    },
    reasons,
    sample_size: candles.length,
  };
}

export function multiTimeframeAnalysis(
  symbol: string,
  candlesByTf: Record<string, Candle[]>,
  calibrations?: Record<string, { slope: number; intercept: number } | null>
) {
  const analyses: Record<string, QuantAnalysisResult> = {};
  for (const [tf, data] of Object.entries(candlesByTf)) {
    if (TIMEFRAMES[tf] && data.length >= 35) {
      analyses[tf] = analyzeCandles(symbol, tf, data, calibrations?.[tf] ?? null);
    }
  }
  const vals = Object.values(analyses);
  const weighted = vals.reduce(
    (sum, x) => sum + (x.direction === 'BUY' ? 1 : x.direction === 'SELL' ? -1 : 0) * x.raw_confidence,
    0
  );
  const denom = vals.reduce((sum, x) => sum + x.raw_confidence, 0) || 1;
  const consensusScore = weighted / denom;
  return {
    symbol,
    timeframes: analyses,
    consensus: consensusScore >= 0.25 ? 'BUY' : consensusScore <= -0.25 ? 'SELL' : 'MIXED',
    consensus_score: Number(consensusScore.toFixed(4)),
    alignment: Number(Math.abs(consensusScore).toFixed(4)),
  };
}

// ---------------- BACKTEST & ROLLING WALK-FORWARD ----------------

export interface BacktestConfig {
  initial_equity: number;
  risk_fraction: number;
  fee_rate: number;
  slippage_bps: number;
  threshold: number;
}

export function performanceMetrics(equityCurve: number[], trades: Array<{ pnl: number }>) {
  if (!equityCurve.length) throw new Error('Equity curve cannot be empty');
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    if (equityCurve[i - 1]) returns.push(equityCurve[i] / equityCurve[i - 1] - 1);
  }
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const v of equityCurve) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avg = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std =
    returns.length > 1
      ? Math.sqrt(returns.reduce((s, x) => s + (x - avg) ** 2, 0) / (returns.length - 1))
      : 0;

  return {
    total_return: equityCurve[0] ? Number((equityCurve[equityCurve.length - 1] / equityCurve[0] - 1).toFixed(6)) : 0,
    max_drawdown: Number(maxDd.toFixed(6)),
    trade_count: trades.length,
    win_rate: trades.length ? Number((wins.length / trades.length).toFixed(4)) : 0,
    profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : grossProfit === 0 ? null : 'infinite',
    average_trade_pnl: trades.length ? Number((trades.reduce((s, t) => s + t.pnl, 0) / trades.length).toFixed(6)) : 0,
    sharpe_per_bar: std > 0 ? Number(((avg / std) * Math.sqrt(returns.length)).toFixed(4)) : 0,
    ending_equity: Number(equityCurve[equityCurve.length - 1].toFixed(2)),
  };
}

export function runBacktest(symbol: string, timeframe: string, rawCandles: Candle[], cfg: BacktestConfig) {
  if (cfg.initial_equity <= 0 || cfg.risk_fraction <= 0 || cfg.risk_fraction > 0.02 || cfg.fee_rate < 0 || cfg.slippage_bps < 0) {
    throw new Error('Invalid backtest configuration');
  }
  const candles = [...rawCandles].sort((a, b) => a.epoch - b.epoch);
  let equity = cfg.initial_equity;
  const curve: number[] = [equity];
  const trades: Array<{ entry_epoch: number; side: string; entry: number; exit: number; units: number; pnl: number; regime: string }> = [];

  // Precompute indicators once per candle loop using strict historical prefixes (no look-ahead)
  for (let i = 35; i < candles.length - 1; i += 1) {
    const sample = candles.slice(Math.max(0, i - 140), i + 1);
    const signal = analyzeCandles(symbol, timeframe, sample);
    if (signal.direction === 'NEUTRAL' || Math.abs(signal.score) < cfg.threshold) continue;
    const entry = candles[i + 1].open;
    const exitPrice = candles[i + 1].close;
    const side = signal.direction === 'BUY' ? 1 : -1;
    const stopDistance = signal.indicators.atr14 ?? 0;
    if (stopDistance <= 0 || entry <= 0) continue;
    const riskCash = equity * cfg.risk_fraction;
    const units = riskCash / stopDistance;
    const gross = side * (exitPrice - entry) * units;
    const costs = Math.abs(entry * units) * (cfg.fee_rate * 2 + (cfg.slippage_bps / 10000) * 2);
    const pnl = gross - costs;
    equity += pnl;
    trades.push({
      entry_epoch: candles[i + 1].epoch,
      side: signal.direction,
      entry,
      exit: exitPrice,
      units: Number(units.toFixed(4)),
      pnl: Number(pnl.toFixed(4)),
      regime: signal.regime,
    });
    curve.push(Number(equity.toFixed(2)));
  }

  return {
    symbol,
    timeframe,
    config: cfg,
    metrics: performanceMetrics(curve, trades),
    equity_curve: curve,
    trades: trades.slice(-200),
    disclaimer:
      'Hypothetical research backtest with next-bar execution and simulated slippage/fees. Not a live Deriv contract quote or guarantee of future returns.',
  };
}

export function walkForwardValidation(
  symbol: string,
  timeframe: string,
  rawCandles: Candle[],
  trainSize = 300,
  testSize = 80,
  step = 80
) {
  const candles = [...rawCandles].sort((a, b) => a.epoch - b.epoch);
  if (trainSize < 80 || testSize < 36 || step < 1) {
    throw new Error('Invalid walk-forward windows');
  }
  const folds: Array<{
    fold: number;
    train_start: number;
    train_end: number;
    test_start: number;
    test_end: number;
    selected_threshold: number;
    out_of_sample: ReturnType<typeof performanceMetrics> | null;
  }> = [];

  let start = 0;
  while (start + trainSize + testSize <= candles.length) {
    const train = candles.slice(start, start + trainSize);
    const test = candles.slice(start + trainSize, start + trainSize + testSize);
    const scores: number[] = [];
    const stride = Math.max(1, Math.floor(train.length / 40));
    for (let i = 35; i < train.length - 1; i += stride) {
      const res = analyzeCandles(symbol, timeframe, train.slice(0, i + 1));
      scores.push(Math.abs(res.score));
    }
    scores.sort((a, b) => a - b);
    const threshold = Math.max(0.35, scores[Math.floor(scores.length / 2)] ?? 0.35);
    const oos =
      test.length >= 36
        ? runBacktest(symbol, timeframe, test, {
            initial_equity: 10000,
            risk_fraction: 0.005,
            fee_rate: 0.0002,
            slippage_bps: 2,
            threshold,
          }).metrics
        : null;
    folds.push({
      fold: folds.length + 1,
      train_start: train[0].epoch,
      train_end: train[train.length - 1].epoch,
      test_start: test[0].epoch,
      test_end: test[test.length - 1].epoch,
      selected_threshold: Number(threshold.toFixed(3)),
      out_of_sample: oos,
    });
    start += step;
  }

  return {
    symbol,
    timeframe,
    folds,
    fold_count: folds.length,
    method: 'Rolling-origin chronological walk-forward validation (zero look-ahead)',
  };
}

// ---------------- PAPER TRADING & INTEGER-CENT MATH ----------------

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function validatePaperOrder(params: {
  equity: number;
  availableBalance: number;
  stake: number;
  expirySeconds: number;
  openPositions: number;
  dailyRealizedPnl: number;
}) {
  const { equity, availableBalance, stake, expirySeconds, openPositions, dailyRealizedPnl } = params;
  if (![equity, availableBalance, stake, dailyRealizedPnl].every(Number.isFinite)) {
    throw new Error('All monetary values must be finite');
  }
  if (equity <= 0 || availableBalance < 0 || stake <= 0) {
    throw new Error('Equity and stake must be positive');
  }
  if (toCents(stake) > toCents(availableBalance)) {
    throw new Error('Stake exceeds available paper balance');
  }
  if (stake > equity * 0.02 + 1e-8) {
    throw new Error('Stake exceeds the 2.0% per-position risk cap');
  }
  if (expirySeconds < 1 || expirySeconds > 86400) {
    throw new Error('Expiry must be between 1 second and 24 hours');
  }
  if (openPositions >= 5) {
    throw new Error('Maximum of 5 open paper positions reached');
  }
  if (dailyRealizedPnl <= -(equity * 0.05)) {
    throw new Error('5.0% daily paper loss stop reached — trading paused until next UTC day');
  }
}
