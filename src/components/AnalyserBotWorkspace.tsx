import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  CheckCircle2,
  Compass,
  Hash,
  Play,
  Radar,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type {
  ActiveSymbol,
  AiAnalyzeBrief,
  DerivSessionState,
  DigitsFullResponse,
  DqiTab,
  LiveDerivContract,
  LiveTickEvent,
  QuantAnalysis,
} from '../types/dqi';

interface AnalyserBotWorkspaceProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  latestTick: LiveTickEvent | null;
  liveTapeBuffer: LiveTickEvent[];
  derivSession: DerivSessionState;
  liveContracts: LiveDerivContract[];
  onOpenConnect: () => void;
  onJumpToTab: (tab: DqiTab) => void;
}

const BEGINNER_MARKETS = [
  { code: '1HZ100V', label: 'Volatility 100 (1s)' },
  { code: 'R_100', label: 'Volatility 100' },
  { code: 'R_75', label: 'Volatility 75' },
  { code: 'R_10', label: 'Volatility 10' },
];

const STAKE_PRESETS = [0.5, 1, 2, 5];

function friendlyVolatility(regime: string | undefined): { label: string; hint: string } {
  switch (regime) {
    case 'VERY_LOW':
    case 'LOW':
      return { label: 'Calm Market', hint: 'Small steady price steps' };
    case 'NORMAL':
      return { label: 'Normal Speed', hint: 'Balanced tick movement' };
    case 'HIGH':
    case 'EXTREME':
      return { label: 'Fast / Volatile', hint: 'Larger price jumps — use small stakes' };
    default:
      return { label: 'Live Tick Flow', hint: 'Tracking incoming ticks' };
  }
}

export const AnalyserBotWorkspace: React.FC<AnalyserBotWorkspaceProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  latestTick,
  liveTapeBuffer,
  derivSession,
  liveContracts,
  onOpenConnect,
  onJumpToTab,
}) => {
  const [tickWindow, setTickWindow] = useState(100);
  const [chartTimeframe, setChartTimeframe] = useState('M5');
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  const [digitsData, setDigitsData] = useState<DigitsFullResponse | null>(null);
  const [quantData, setQuantData] = useState<QuantAnalysis | null>(null);

  // Server-side Gemini AI brief
  const [aiBrief, setAiBrief] = useState<AiAnalyzeBrief | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Real Deriv Trade Box (Demo VRTC or Real CR)
  const [tradeType, setTradeType] = useState<'CALL' | 'PUT' | 'DIGITEVEN' | 'DIGITODD' | 'DIGITDIFF'>('CALL');
  const [tradeDigit, setTradeDigit] = useState<number>(0);
  const [tradeStake, setTradeStake] = useState<number>(1);
  const [tradeDuration, setTradeDuration] = useState<number>(5);
  const [tradeUnit, setTradeUnit] = useState<'t' | 's'>('t');
  const [liveProposal, setLiveProposal] = useState<{
    askPrice: number;
    payout: number;
    breakEvenProbPct: number | null;
  } | null>(null);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);
  const [realTradeConfirm, setRealTradeConfirm] = useState(false);

  const loadAnalysis = useCallback(async () => {
    setLoadingData(true);
    setDataError(null);
    try {
      const [digRes, qRes] = await Promise.all([
        dqiApi.analyzeDigits(selectedSymbol, tickWindow, tradeStake, 1).catch(() => null),
        dqiApi.analyzeQuant(selectedSymbol, chartTimeframe, 160).catch(() => null),
      ]);
      if (!digRes && !qRes) {
        throw new Error('Waiting for Deriv public WebSocket response. Tap Refresh to retry.');
      }
      if (digRes) setDigitsData(digRes);
      if (qRes) setQuantData(qRes);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to analyze market');
    } finally {
      setLoadingData(false);
    }
  }, [selectedSymbol, tickWindow, chartTimeframe, tradeStake]);

  useEffect(() => {
    setAiBrief(null);
    setAiError(null);
    void loadAnalysis();
  }, [loadAnalysis]);

  // Live proposal calculation whenever contract type, digit, stake, or duration changes
  useEffect(() => {
    let cancelled = false;
    const isDigit = tradeType === 'DIGITEVEN' || tradeType === 'DIGITODD' || tradeType === 'DIGITDIFF';
    const dur = isDigit ? Math.min(10, Math.max(1, tradeDuration)) : tradeDuration;
    const unit = isDigit ? 't' : tradeUnit;
    void dqiApi
      .getProposal({
        symbol: selectedSymbol,
        contractType: tradeType,
        amount: tradeStake,
        duration: dur,
        durationUnit: unit,
        barrier: tradeType === 'DIGITDIFF' ? String(tradeDigit) : undefined,
      })
      .then((p) => {
        if (!cancelled) {
          setLiveProposal({
            askPrice: p.askPrice,
            payout: p.payout,
            breakEvenProbPct: p.breakEvenProbPct,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setLiveProposal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, tradeType, tradeDigit, tradeStake, tradeDuration, tradeUnit]);

  const displayQuote = latestTick?.rawQuote ?? digitsData?.analytics.latestQuote ?? null;
  const displayDigit = latestTick?.lastDigit ?? digitsData?.analytics.latestObservedDigit ?? null;

  // REAL-TIME tick-by-tick digit frequency calculation (combines initial history + live streaming ticks)
  const liveDigitsComputation = useMemo(() => {
    const baseTape = (digitsData?.analytics.tape ?? []).map((t) => ({
      digit: t.digit,
      quote: t.quote,
      epoch: t.epoch,
    }));
    const liveItems = liveTapeBuffer.map((t) => ({
      digit: t.lastDigit,
      quote: t.rawQuote,
      epoch: t.epoch,
    }));

    // Merge without duplicates and slice to selected tickWindow
    const seen = new Set<string>();
    const merged: Array<{ digit: number; quote: string; epoch: number }> = [];
    for (const item of [...baseTape, ...liveItems]) {
      const key = `${item.epoch}:${item.quote}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    const windowSlice = merged.slice(-tickWindow);
    const total = windowSlice.length;

    if (total === 0) {
      return {
        total: 0,
        evenPct: 50,
        oddPct: 50,
        over4Pct: 50,
        under5Pct: 50,
        digits: Array.from({ length: 10 }, (_, d) => ({ digit: d, count: 0, percentage: 0 })),
        tape20: [] as Array<{ digit: number; quote: string; epoch: number }>,
      };
    }

    const counts = Array.from({ length: 10 }, () => 0);
    let even = 0;
    let over4 = 0;
    for (const row of windowSlice) {
      counts[row.digit] += 1;
      if (row.digit % 2 === 0) even += 1;
      if (row.digit > 4) over4 += 1;
    }

    return {
      total,
      evenPct: (even / total) * 100,
      oddPct: ((total - even) / total) * 100,
      over4Pct: (over4 / total) * 100,
      under5Pct: ((total - over4) / total) * 100,
      digits: counts.map((count, digit) => ({
        digit,
        count,
        percentage: (count / total) * 100,
      })),
      tape20: windowSlice.slice(-20),
    };
  }, [digitsData, liveTapeBuffer, tickWindow]);

  const hottestDigit = useMemo(() => {
    if (liveDigitsComputation.total === 0) return null;
    const top = [...liveDigitsComputation.digits].sort((a, b) => b.count - a.count)[0];
    return { digit: top.digit, pct: top.percentage };
  }, [liveDigitsComputation]);

  const coldestDigit = useMemo(() => {
    if (liveDigitsComputation.total === 0) return null;
    const low = [...liveDigitsComputation.digits].sort((a, b) => a.count - b.count)[0];
    return { digit: low.digit, pct: low.percentage };
  }, [liveDigitsComputation]);

  const deterministicVerdict = useMemo(() => {
    const dir = quantData?.direction;
    const conf = quantData ? Math.round(quantData.calibrated_confidence * 100) : 0;
    const evenPct = liveDigitsComputation.evenPct;
    const overPct = liveDigitsComputation.over4Pct;

    if (dir === 'BUY' && conf >= 58) {
      return {
        title: `Upward Trend (${conf}% confidence)`,
        tone: 'buy' as const,
        reason: 'Recent candles show upward momentum above short-term average.',
      };
    }
    if (dir === 'SELL' && conf >= 58) {
      return {
        title: `Downward Trend (${conf}% confidence)`,
        tone: 'sell' as const,
        reason: 'Recent candles show downward momentum below short-term average.',
      };
    }
    if (Math.abs(evenPct - 50) >= 8 && liveDigitsComputation.total >= 20) {
      const side = evenPct > 50 ? 'Even' : 'Odd';
      return {
        title: `${side} Digits Active (${Math.max(evenPct, 100 - evenPct).toFixed(0)}%)`,
        tone: 'blue' as const,
        reason: `In the last ${liveDigitsComputation.total} ticks, ${side.toLowerCase()} digits appeared more often.`,
      };
    }
    if (Math.abs(overPct - 50) >= 8 && liveDigitsComputation.total >= 20) {
      const side = overPct > 50 ? 'Over 4 (5–9)' : 'Under 5 (0–4)';
      return {
        title: `${side} Active (${Math.max(overPct, 100 - overPct).toFixed(0)}%)`,
        tone: 'blue' as const,
        reason: `Recent ticks leaned toward ${side} in this window.`,
      };
    }
    return {
      title: 'Balanced Market — Wait or Trade Small',
      tone: 'neutral' as const,
      reason: 'Neither trend nor digit counts show a strong skew right now.',
    };
  }, [quantData, liveDigitsComputation]);

  const handleAskAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const matchBe = digitsData?.matchCandidates?.[0]?.breakEvenProbPct ?? null;
      const differBe = digitsData?.differCandidates?.[0]?.breakEvenProbPct ?? null;
      const brief = await dqiApi.generateAiBrief({
        symbol: selectedSymbol,
        spotQuote: displayQuote,
        latestDigit: displayDigit,
        tickWindowCount: liveDigitsComputation.total,
        volatilityRegime: digitsData?.volatility.regime ?? 'NORMAL',
        evenPct: liveDigitsComputation.evenPct,
        oddPct: liveDigitsComputation.oddPct,
        over4Pct: liveDigitsComputation.over4Pct,
        under5Pct: liveDigitsComputation.under5Pct,
        hottestDigit,
        coldestDigit,
        matchBreakEvenPct: matchBe,
        differBreakEvenPct: differBe,
        quantDirection: quantData?.direction ?? null,
        quantConfidencePct: quantData ? quantData.calibrated_confidence * 100 : null,
        quantRegime: quantData?.regime ?? null,
        rsi14: quantData?.indicators.rsi14 ?? null,
      });
      setAiBrief(brief);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to reach AI Analyst');
    } finally {
      setAiLoading(false);
    }
  };

  const handlePlaceDerivTrade = async () => {
    if (!derivSession.connected) {
      onOpenConnect();
      return;
    }
    if (!derivSession.activeIsVirtual && !realTradeConfirm) {
      setTradeMsg('Please tick the Real Account confirmation checkbox before placing a live trade.');
      return;
    }

    setTradeBusy(true);
    setTradeMsg(null);
    try {
      const isDigit = tradeType === 'DIGITEVEN' || tradeType === 'DIGITODD' || tradeType === 'DIGITDIFF';
      const contract = await dqiApi.buyDerivContract({
        symbol: selectedSymbol,
        contractType: tradeType,
        amount: tradeStake,
        duration: isDigit ? Math.min(10, Math.max(1, tradeDuration)) : tradeDuration,
        durationUnit: isDigit ? 't' : tradeUnit,
        barrier: tradeType === 'DIGITDIFF' ? String(tradeDigit) : undefined,
      });
      setRealTradeConfirm(false);
      setTradeMsg(
        `Opened #${contract.contractId} on ${contract.isVirtual ? 'Deriv Demo' : 'Deriv Real'} (${contract.loginid}). Live P&L updating tick-by-tick below.`
      );
    } catch (err) {
      setTradeMsg(err instanceof Error ? err.message : 'Order execution failed');
    } finally {
      setTradeBusy(false);
    }
  };

  const handleSellEarly = async (contractId: number) => {
    try {
      await dqiApi.sellDerivContract(contractId);
    } catch (err) {
      setTradeMsg(err instanceof Error ? err.message : 'Unable to close contract early');
    }
  };

  const volInfo = friendlyVolatility(digitsData?.volatility.regime);
  const selectedMarketName =
    symbols.find((s) => s.symbol === selectedSymbol)?.display_name ||
    BEGINNER_MARKETS.find((m) => m.code === selectedSymbol)?.label ||
    selectedSymbol;

  const isDigitSelected = tradeType === 'DIGITEVEN' || tradeType === 'DIGITODD' || tradeType === 'DIGITDIFF';

  return (
    <div className="space-y-4">
      {/* Step 1: Simple Market & Speed Selector Bar */}
      <div className="rounded-lg border border-[#E5E9EF] bg-white p-4 dark:border-[#243040] dark:bg-[#151D27]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-bold text-[#20242B] dark:text-white">
              AI Market Analyser Bot
            </h1>
            <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
              Real-time Deriv quotes, tick-by-tick calculations, AI explanation, and direct Demo/Real account execution.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Tick sample size"
              value={tickWindow}
              onChange={(e) => setTickWindow(Number(e.target.value))}
              className="rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 text-xs font-medium text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
            >
              <option value={50}>Last 50 Ticks</option>
              <option value={100}>Last 100 Ticks</option>
              <option value={250}>Last 250 Ticks</option>
            </select>

            <select
              aria-label="Chart timeframe"
              value={chartTimeframe}
              onChange={(e) => setChartTimeframe(e.target.value)}
              className="rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 text-xs font-medium text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
            >
              <option value="M1">1m Trend</option>
              <option value="M5">5m Trend</option>
              <option value="M15">15m Trend</option>
              <option value="H1">1h Trend</option>
            </select>

            <button
              type="button"
              onClick={() => void loadAnalysis()}
              disabled={loadingData}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-1.5 text-xs font-semibold text-[#20242B] hover:bg-[#EAEFF5] disabled:opacity-50 dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingData ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Beginner Quick Market Buttons + Full Searchable Select */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {BEGINNER_MARKETS.map((m) => {
            const active = selectedSymbol === m.code;
            return (
              <button
                key={m.code}
                type="button"
                onClick={() => onSelectSymbol(m.code)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  active
                    ? 'bg-[#0866FF] text-white'
                    : 'border border-[#E5E9EF] bg-[#F5F7FA] text-[#20242B] hover:border-[#0866FF]/50 dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                }`}
              >
                {m.label}
              </button>
            );
          })}

          {symbols.length > 0 && (
            <select
              aria-label="All Deriv markets"
              value={selectedSymbol}
              onChange={(e) => onSelectSymbol(e.target.value)}
              className="max-w-[230px] rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1.5 text-xs text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
            >
              {symbols.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.display_name} ({s.symbol})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {dataError && (
        <div className="rounded-lg border border-[#FF444F]/40 bg-[#FF444F]/10 px-4 py-2.5 text-xs text-[#FF444F]">
          {dataError}
        </div>
      )}

      {/* Main 2-Column Easy View */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
        {/* LEFT (7 cols): Live Real-Time Analyser Dashboard */}
        <div className="flex flex-col justify-between space-y-4 rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27] lg:col-span-7">
          <div>
            {/* Live Price + Big Digit Tile */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E9EF] pb-4 dark:border-[#243040]">
              <div>
                <div className="text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  {selectedMarketName} · Live Tick Feed ({liveDigitsComputation.total} ticks)
                </div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#20242B] dark:text-white">
                  {displayQuote ?? 'Connecting to Deriv…'}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Latest Last Digit</div>
                  <div className="text-xs font-medium text-[#20242B] dark:text-[#F3F4F6]">
                    {displayDigit !== null
                      ? `${displayDigit % 2 === 0 ? 'Even' : 'Odd'} · ${displayDigit > 4 ? 'Over 4' : 'Under 5'}`
                      : 'Waiting'}
                  </div>
                </div>
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-[#101820] font-mono text-2xl font-bold tabular-nums text-white dark:bg-[#0866FF]">
                  {displayDigit !== null ? displayDigit : '—'}
                </div>
              </div>
            </div>

            {/* Clear Bot Verdict Banner */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-[#F5F7FA] p-3.5 dark:bg-[#0F151D]">
              <div className="flex items-start gap-2.5">
                {deterministicVerdict.tone === 'buy' ? (
                  <ArrowUpRight className="mt-0.5 h-5 w-5 shrink-0 text-[#00A88F]" />
                ) : deterministicVerdict.tone === 'sell' ? (
                  <ArrowDownRight className="mt-0.5 h-5 w-5 shrink-0 text-[#FF4D5A]" />
                ) : (
                  <Bot className="mt-0.5 h-5 w-5 shrink-0 text-[#0866FF]" />
                )}
                <div>
                  <div className="text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                    Live Bot Signal
                  </div>
                  <div
                    className={`text-sm font-bold ${
                      deterministicVerdict.tone === 'buy'
                        ? 'text-[#00A88F]'
                        : deterministicVerdict.tone === 'sell'
                        ? 'text-[#FF4D5A]'
                        : 'text-[#20242B] dark:text-white'
                    }`}
                  >
                    {deterministicVerdict.title}
                  </div>
                  <div className="mt-0.5 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                    {deterministicVerdict.reason}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Market Speed</div>
                <div className="text-xs font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                  {volInfo.label}
                </div>
                <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">{volInfo.hint}</div>
              </div>
            </div>

            {/* Even/Odd & Over/Under Live Balance Bars */}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="flex justify-between font-mono text-xs font-medium tabular-nums">
                  <span className="text-[#00A88F]">
                    Even {liveDigitsComputation.total > 0 ? `${liveDigitsComputation.evenPct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="text-[#0866FF]">
                    Odd {liveDigitsComputation.total > 0 ? `${liveDigitsComputation.oddPct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2.5 overflow-hidden rounded bg-[#E5E9EF] dark:bg-[#243040]">
                  <div className="bg-[#00A88F]" style={{ width: `${liveDigitsComputation.evenPct}%` }} />
                  <div className="bg-[#0866FF]" style={{ width: `${liveDigitsComputation.oddPct}%` }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between font-mono text-xs font-medium tabular-nums">
                  <span className="text-[#08B9E6]">
                    Over 4 {liveDigitsComputation.total > 0 ? `${liveDigitsComputation.over4Pct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="text-[#FF4D5A]">
                    Under 5 {liveDigitsComputation.total > 0 ? `${liveDigitsComputation.under5Pct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2.5 overflow-hidden rounded bg-[#E5E9EF] dark:bg-[#243040]">
                  <div className="bg-[#08B9E6]" style={{ width: `${liveDigitsComputation.over4Pct}%` }} />
                  <div className="bg-[#FF4D5A]" style={{ width: `${liveDigitsComputation.under5Pct}%` }} />
                </div>
              </div>
            </div>

            {/* 0–9 Real-Time Digit Frequency Bars */}
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                  Live Last-Digit Frequency (0–9) · Click a digit to select Differ
                </span>
                <span className="font-mono text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                  Baseline: 10.0%
                </span>
              </div>

              <div className="mt-3 grid grid-cols-10 gap-1.5">
                {liveDigitsComputation.digits.map((row) => {
                  const isLatest = displayDigit === row.digit;
                  const isHighest = hottestDigit?.digit === row.digit && row.count > 0;
                  const isLowest = coldestDigit?.digit === row.digit && row.count > 0;
                  const barHeight = Math.min(100, Math.max(8, (row.percentage / 22) * 100));
                  return (
                    <button
                      key={row.digit}
                      type="button"
                      onClick={() => {
                        setTradeDigit(row.digit);
                        setTradeType('DIGITDIFF');
                      }}
                      className={`flex flex-col items-center rounded-md border p-1.5 transition ${
                        isLatest
                          ? 'border-[#0866FF] bg-[#0866FF]/10'
                          : 'border-[#E5E9EF] bg-[#F5F7FA] hover:border-[#0866FF]/50 dark:border-[#243040] dark:bg-[#0F151D]'
                      }`}
                    >
                      <span className="font-mono text-[11px] tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                        {row.percentage.toFixed(0)}%
                      </span>
                      <div className="my-1.5 flex h-16 w-full items-end justify-center">
                        <div
                          className={`w-3.5 rounded-t ${
                            isHighest
                              ? 'bg-[#FF444F]'
                              : isLowest
                              ? 'bg-[#00A88F]'
                              : 'bg-[#0866FF]'
                          }`}
                          style={{ height: `${barHeight}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs font-bold tabular-nums text-[#20242B] dark:text-white">
                        {row.digit}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                Updates every tick in real time. Red = highest frequency · Green = lowest frequency. Past ticks never predict the next tick.
              </p>
            </div>
          </div>

          {/* Live Last 20 Digits Tape */}
          <div className="border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
            <div className="mb-1.5 text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
              Live Tick Stream (Newest on right)
            </div>
            <div className="flex flex-wrap gap-1">
              {liveDigitsComputation.tape20.length === 0 ? (
                <span className="text-xs text-[#6B7280]">Waiting for incoming ticks…</span>
              ) : (
                liveDigitsComputation.tape20.map((item, idx) => {
                  const isNewest = idx === liveDigitsComputation.tape20.length - 1;
                  return (
                    <span
                      key={`${item.epoch}-${idx}`}
                      title={item.quote}
                      className={`flex h-7 w-7 items-center justify-center rounded font-mono text-xs font-bold tabular-nums ${
                        isNewest
                          ? 'bg-[#0866FF] text-white'
                          : item.digit % 2 === 0
                          ? 'bg-[#00A88F]/15 text-[#00A88F]'
                          : 'bg-[#F5F7FA] text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                      }`}
                    >
                      {item.digit}
                    </span>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* RIGHT (5 cols): AI Market Brief + Live Deriv Demo / Real Trading Panel */}
        <div className="flex flex-col justify-between space-y-4 lg:col-span-5">
          {/* AI Analyst Brief */}
          <div className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[#0866FF]" />
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  AI Market Explanation
                </h2>
              </div>
              <button
                type="button"
                onClick={handleAskAi}
                disabled={aiLoading}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#0866FF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0654d4] disabled:opacity-50"
              >
                <Bot className="h-3.5 w-3.5" />
                {aiLoading ? 'Analyzing…' : aiBrief ? 'Re-Analyze' : 'Ask AI Analyst'}
              </button>
            </div>

            {aiError && (
              <div className="mt-3 rounded-md border border-[#FF444F]/40 bg-[#FF444F]/10 p-3 text-xs text-[#FF444F]">
                {aiError}
              </div>
            )}

            {!aiBrief && !aiError && (
              <div className="mt-3 rounded-md bg-[#F5F7FA] p-3.5 text-xs text-[#6B7280] dark:bg-[#0F151D] dark:text-[#9CA3AF]">
                Click <strong>Ask AI Analyst</strong> for a plain-English summary of the live quotes, digit frequencies, and trend indicators.
              </div>
            )}

            {aiBrief && (
              <div className="mt-3 space-y-2.5 text-xs">
                <div className="rounded-md bg-[#F5F7FA] p-3 dark:bg-[#0F151D]">
                  <div className="font-bold text-[#20242B] dark:text-white">{aiBrief.headline}</div>
                  <p className="mt-1 leading-relaxed text-[#6B7280] dark:text-[#9CA3AF]">
                    {aiBrief.plainSummary}
                  </p>
                  <div className="mt-2 font-semibold text-[#0866FF]">
                    Suggested Setup: {aiBrief.bestSetup}
                  </div>
                </div>

                {aiBrief.whyBullets.length > 0 && (
                  <ul className="space-y-1 pl-4 text-[#20242B] dark:text-[#D1D5DB]">
                    {aiBrief.whyBullets.map((b, i) => (
                      <li key={i} className="list-disc">
                        {b}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex items-start gap-2 rounded-md border border-[#00A88F]/30 bg-[#00A88F]/8 p-2.5 text-[#00A88F]">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{aiBrief.beginnerTip}</span>
                </div>
              </div>
            )}
          </div>

          {/* Real Deriv Demo / Real Live Trade Execution & Tick-by-Tick P&L */}
          <div className="flex-1 rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  {derivSession.connected
                    ? `Trade on Deriv ${derivSession.activeIsVirtual ? 'Demo' : 'REAL'} (${derivSession.activeLoginId})`
                    : 'Connect Deriv Account to Trade'}
                </h2>
                <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  {derivSession.connected ? (
                    <>
                      Live Balance:{' '}
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          derivSession.activeIsVirtual ? 'text-[#00A88F]' : 'text-[#FF444F]'
                        }`}
                      >
                        {derivSession.activeBalance !== null
                          ? `${derivSession.activeBalance.toFixed(2)} ${derivSession.activeCurrency}`
                          : 'Loading…'}
                      </span>
                    </>
                  ) : (
                    'Log in with Deriv OAuth or API Token to trade live Demo first, then switch to Real.'
                  )}
                </p>
              </div>
              {derivSession.connected ? (
                <CheckCircle2 className="h-4 w-4 text-[#00A88F]" />
              ) : (
                <Wallet className="h-4 w-4 text-[#0866FF]" />
              )}
            </div>

            {!derivSession.connected ? (
              <div className="mt-4 space-y-3 rounded-md bg-[#F5F7FA] p-4 dark:bg-[#0F151D]">
                <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  Connect your actual Deriv account to view your <strong>Demo (VRTC)</strong> &amp; <strong>Real (CR)</strong> balances, execute trades, and see real-time profit/loss calculate on every tick.
                </p>
                <button
                  type="button"
                  onClick={onOpenConnect}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-[#0866FF] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#0654d4]"
                >
                  <Wallet className="h-4 w-4" />
                  Connect Deriv Demo &amp; Real Account
                </button>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div>
                  <div className="mb-1.5 text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                    1. Contract Type
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                    {(
                      [
                        { id: 'CALL', label: 'Rise' },
                        { id: 'PUT', label: 'Fall' },
                        { id: 'DIGITEVEN', label: 'Even' },
                        { id: 'DIGITODD', label: 'Odd' },
                        { id: 'DIGITDIFF', label: `Diff ${tradeDigit}` },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setTradeType(opt.id)}
                        className={`rounded-md py-1.5 text-xs font-semibold transition ${
                          tradeType === opt.id
                            ? opt.id === 'PUT'
                              ? 'bg-[#FF4D5A] text-white'
                              : 'bg-[#00A88F] text-white'
                            : 'border border-[#E5E9EF] bg-[#F5F7FA] text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="mb-1 text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                      2. Stake ({derivSession.activeCurrency})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {STAKE_PRESETS.map((amt) => (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => setTradeStake(amt)}
                          className={`rounded px-2.5 py-1 font-mono text-xs font-semibold tabular-nums ${
                            tradeStake === amt
                              ? 'bg-[#101820] text-white dark:bg-[#0866FF]'
                              : 'border border-[#E5E9EF] bg-[#F5F7FA] text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                          }`}
                        >
                          ${amt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                      3. Duration
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={isDigitSelected ? 10 : 300}
                        value={isDigitSelected ? Math.min(10, tradeDuration) : tradeDuration}
                        onChange={(e) => setTradeDuration(Math.max(1, Number(e.target.value)))}
                        className="w-16 rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                      />
                      {!isDigitSelected ? (
                        <select
                          value={tradeUnit}
                          onChange={(e) => setTradeUnit(e.target.value as 't' | 's')}
                          className="flex-1 rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 text-xs text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                        >
                          <option value="t">Ticks</option>
                          <option value="s">Seconds</option>
                        </select>
                      ) : (
                        <span className="self-center text-xs text-[#6B7280]">Ticks</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Live Deriv Payout Quote Preview */}
                {liveProposal && (
                  <div className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 font-mono text-xs tabular-nums dark:bg-[#0F151D]">
                    <span className="text-[#6B7280] dark:text-[#9CA3AF]">
                      Payout: <strong className="text-[#20242B] dark:text-white">${liveProposal.payout.toFixed(2)}</strong>
                    </span>
                    <span className="text-[#6B7280] dark:text-[#9CA3AF]">
                      Return:{' '}
                      <strong className="text-[#00A88F]">
                        +${(liveProposal.payout - liveProposal.askPrice).toFixed(2)} (
                        {(((liveProposal.payout - liveProposal.askPrice) / liveProposal.askPrice) * 100).toFixed(1)}%)
                      </strong>
                    </span>
                  </div>
                )}

                {!derivSession.activeIsVirtual && (
                  <label className="flex items-center gap-2 rounded border border-[#FF444F]/40 bg-[#FF444F]/10 px-3 py-2 text-xs text-[#FF444F]">
                    <input
                      type="checkbox"
                      checked={realTradeConfirm}
                      onChange={(e) => setRealTradeConfirm(e.target.checked)}
                      className="h-4 w-4 accent-[#FF444F]"
                    />
                    <span>Confirm live trade using REAL balance ({derivSession.activeLoginId})</span>
                  </label>
                )}

                <button
                  type="button"
                  disabled={tradeBusy}
                  onClick={handlePlaceDerivTrade}
                  className={`flex w-full items-center justify-center gap-1.5 rounded-md px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50 ${
                    derivSession.activeIsVirtual
                      ? 'bg-[#00A88F] hover:bg-[#00917b]'
                      : 'bg-[#FF444F] hover:bg-[#e53843]'
                  }`}
                >
                  <Play className="h-3.5 w-3.5" />
                  {tradeBusy
                    ? 'Sending Order to Deriv…'
                    : `Place ${tradeType} on ${derivSession.activeIsVirtual ? 'Demo' : 'REAL'} ($${tradeStake})`}
                </button>

                {tradeMsg && (
                  <div className="rounded-md bg-[#F5F7FA] px-3 py-2 text-xs text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]">
                    {tradeMsg}
                  </div>
                )}

                {/* Real-Time Open & Settled Contracts (proposal_open_contract live P&L) */}
                {liveContracts.length > 0 && (
                  <div className="space-y-1.5 border-t border-[#E5E9EF] pt-2.5 dark:border-[#243040]">
                    <div className="text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                      Real-Time Contract Calculations (Updates Every Tick)
                    </div>
                    {liveContracts.slice(0, 5).map((c) => (
                      <div
                        key={c.contractId}
                        className="rounded bg-[#F5F7FA] px-3 py-2 text-xs dark:bg-[#0F151D]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                            {c.contractType} · {c.symbol} · ${c.buyPrice.toFixed(2)}
                          </span>
                          <span
                            className={`font-mono font-bold tabular-nums ${
                              c.profit >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                            }`}
                          >
                            {c.profit >= 0 ? '+' : ''}
                            {c.profit.toFixed(2)} {c.currency} ({c.profitPct >= 0 ? '+' : ''}
                            {c.profitPct.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                          <span className="font-mono tabular-nums">
                            Entry: {c.entrySpot ?? '—'} → Now: {c.currentSpot ?? '—'}
                          </span>
                          {c.status === 'open' && !c.isSold ? (
                            <button
                              type="button"
                              onClick={() => void handleSellEarly(c.contractId)}
                              className="rounded bg-[#0866FF] px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-[#0654d4]"
                            >
                              Sell (${c.bidPrice.toFixed(2)})
                            </button>
                          ) : (
                            <span className="font-mono uppercase">{c.status}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Pro Navigation Strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => onJumpToTab('terminal')}
          className="flex items-center gap-3 rounded-lg border border-[#E5E9EF] bg-white p-3.5 text-left hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27]"
        >
          <BarChart3 className="h-5 w-5 shrink-0 text-[#0866FF]" />
          <div>
            <div className="text-xs font-bold text-[#20242B] dark:text-white">Live Chart Terminal</div>
            <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Candlesticks &amp; order ticket</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onJumpToTab('digits')}
          className="flex items-center gap-3 rounded-lg border border-[#E5E9EF] bg-white p-3.5 text-left hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27]"
        >
          <Hash className="h-5 w-5 shrink-0 text-[#00A88F]" />
          <div>
            <div className="text-xs font-bold text-[#20242B] dark:text-white">Digits Studio Pro</div>
            <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Match/Differ EV &amp; confidence bounds</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onJumpToTab('scanner')}
          className="flex items-center gap-3 rounded-lg border border-[#E5E9EF] bg-white p-3.5 text-left hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27]"
        >
          <Radar className="h-5 w-5 shrink-0 text-[#08B9E6]" />
          <div>
            <div className="text-xs font-bold text-[#20242B] dark:text-white">All-Market Scanner</div>
            <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Scan top markets &amp; backtest</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onJumpToTab('strategy')}
          className="flex items-center gap-3 rounded-lg border border-[#E5E9EF] bg-white p-3.5 text-left hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27]"
        >
          <Compass className="h-5 w-5 shrink-0 text-[#FF444F]" />
          <div>
            <div className="text-xs font-bold text-[#20242B] dark:text-white">Bot Block Builder</div>
            <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Visual blocks, XML &amp; scheduler</div>
          </div>
        </button>
      </div>
    </div>
  );
};
