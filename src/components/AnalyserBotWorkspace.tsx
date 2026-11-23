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
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type {
  ActiveSymbol,
  AiAnalyzeBrief,
  DigitsFullResponse,
  DqiTab,
  LiveTickEvent,
  PaperAccount,
  PaperPosition,
  QuantAnalysis,
} from '../types/dqi';

interface AnalyserBotWorkspaceProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  latestTick: LiveTickEvent | null;
  liveTapeBuffer: LiveTickEvent[];
  paperAccount: PaperAccount | null;
  onJumpToTab: (tab: DqiTab) => void;
  onRefreshSystem: () => void;
}

const BEGINNER_MARKETS = [
  { code: '1HZ100V', label: 'Volatility 100 (1s)' },
  { code: 'R_100', label: 'Volatility 100' },
  { code: 'R_75', label: 'Volatility 75' },
  { code: 'R_10', label: 'Volatility 10' },
];

const STAKE_PRESETS = [1, 2, 5];

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
      return { label: 'Loading Speed', hint: 'Gathering live ticks' };
  }
}

export const AnalyserBotWorkspace: React.FC<AnalyserBotWorkspaceProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  latestTick,
  liveTapeBuffer,
  paperAccount,
  onJumpToTab,
  onRefreshSystem,
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

  // Beginner-friendly virtual practice trade box
  const [practiceType, setPracticeType] = useState<'CALL' | 'PUT' | 'DIGITEVEN' | 'DIGITODD' | 'DIGITDIFF'>('CALL');
  const [practiceDigit, setPracticeDigit] = useState<number>(0);
  const [practiceStake, setPracticeStake] = useState<number>(1);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [practiceMsg, setPracticeMsg] = useState<string | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);

  const loadAnalysis = useCallback(async () => {
    setLoadingData(true);
    setDataError(null);
    try {
      const [digRes, qRes, posRes] = await Promise.all([
        dqiApi.analyzeDigits(selectedSymbol, tickWindow, practiceStake, 1).catch(() => null),
        dqiApi.analyzeQuant(selectedSymbol, chartTimeframe, 160).catch(() => null),
        dqiApi.getPaperPositions().catch(() => ({ positions: [] })),
      ]);
      if (!digRes && !qRes) {
        throw new Error('Waiting for live Deriv market connection. Check your network and tap Refresh.');
      }
      if (digRes) setDigitsData(digRes);
      if (qRes) setQuantData(qRes);
      setPositions(posRes.positions.slice(0, 4));
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to analyze market');
    } finally {
      setLoadingData(false);
    }
  }, [selectedSymbol, tickWindow, chartTimeframe, practiceStake]);

  useEffect(() => {
    setAiBrief(null);
    setAiError(null);
    void loadAnalysis();
  }, [loadAnalysis]);

  // Keep live tape responsive between full reloads
  const displayQuote = latestTick?.rawQuote ?? digitsData?.analytics.latestQuote ?? null;
  const displayDigit = latestTick?.lastDigit ?? digitsData?.analytics.latestObservedDigit ?? null;

  const recentDigits = useMemo(() => {
    if (liveTapeBuffer.length >= 12) {
      return liveTapeBuffer.slice(-20).map((t) => ({ digit: t.lastDigit, quote: t.rawQuote }));
    }
    return (digitsData?.analytics.tape ?? []).slice(-20).map((t) => ({ digit: t.digit, quote: t.quote }));
  }, [liveTapeBuffer, digitsData]);

  // Deterministic plain-English live summary from real telemetry
  const deterministicVerdict = useMemo(() => {
    const dir = quantData?.direction;
    const conf = quantData ? Math.round(quantData.calibrated_confidence * 100) : 0;
    const evenPct = digitsData?.analytics.evenPct ?? 50;
    const overPct = digitsData?.analytics.over4Pct ?? 50;

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
    if (Math.abs(evenPct - 50) >= 8) {
      const side = evenPct > 50 ? 'Even' : 'Odd';
      return {
        title: `${side} Digits Active (${Math.max(evenPct, 100 - evenPct).toFixed(0)}%)`,
        tone: 'blue' as const,
        reason: `In the last ${digitsData?.analytics.sampleCount ?? tickWindow} ticks, ${side.toLowerCase()} digits appeared more often.`,
      };
    }
    if (Math.abs(overPct - 50) >= 8) {
      const side = overPct > 50 ? 'Over 4 (5–9)' : 'Under 5 (0–4)';
      return {
        title: `${side} Active (${Math.max(overPct, 100 - overPct).toFixed(0)}%)`,
        tone: 'blue' as const,
        reason: `Recent ticks leaned toward ${side} in this window.`,
      };
    }
    return {
      title: 'Balanced Market — Wait or Practice Lightly',
      tone: 'neutral' as const,
      reason: 'Neither trend nor digit counts show a strong skew right now.',
    };
  }, [quantData, digitsData, tickWindow]);

  const sortedDigits = useMemo(() => {
    return digitsData?.analytics.digits ?? [];
  }, [digitsData]);

  const hottestDigit = useMemo(() => {
    if (sortedDigits.length === 0) return null;
    const top = [...sortedDigits].sort((a, b) => b.count - a.count)[0];
    return { digit: top.digit, pct: top.percentage };
  }, [sortedDigits]);

  const coldestDigit = useMemo(() => {
    if (sortedDigits.length === 0) return null;
    const low = [...sortedDigits].sort((a, b) => a.count - b.count)[0];
    return { digit: low.digit, pct: low.percentage };
  }, [sortedDigits]);

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
        tickWindowCount: digitsData?.analytics.sampleCount ?? liveTapeBuffer.length,
        volatilityRegime: digitsData?.volatility.regime ?? 'INSUFFICIENT_DATA',
        evenPct: digitsData?.analytics.evenPct ?? 50,
        oddPct: digitsData?.analytics.oddPct ?? 50,
        over4Pct: digitsData?.analytics.over4Pct ?? 50,
        under5Pct: digitsData?.analytics.under5Pct ?? 50,
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

  const handlePracticeTrade = async () => {
    setPracticeBusy(true);
    setPracticeMsg(null);
    try {
      const direction: 'BUY' | 'SELL' = practiceType === 'PUT' ? 'SELL' : 'BUY';
      const payoutMult = practiceType === 'DIGITDIFF' ? 0.1 : 0.95;
      const res = await dqiApi.openPaperTrade({
        symbol: selectedSymbol,
        timeframe: chartTimeframe,
        contractType: practiceType,
        barrier: practiceType === 'DIGITDIFF' ? String(practiceDigit) : undefined,
        direction,
        stake: practiceStake,
        expiry_seconds: 15,
        payout_multiplier: payoutMult,
      });
      setPracticeMsg(
        `Practice ${practiceType} opened on ${selectedSymbol} for $${practiceStake}. Settles automatically or click Settle below.`
      );
      setPositions((prev) => [res.position, ...prev].slice(0, 4));
      onRefreshSystem();
    } catch (err) {
      setPracticeMsg(err instanceof Error ? err.message : 'Could not open practice trade');
    } finally {
      setPracticeBusy(false);
    }
  };

  const handleSettle = async (id: number) => {
    try {
      const res = await dqiApi.settlePaperPosition(id);
      setPositions((prev) => prev.map((p) => (p.position_id === id ? res.position : p)));
      onRefreshSystem();
    } catch (err) {
      setPracticeMsg(err instanceof Error ? err.message : 'Settle failed — wait a few ticks and retry');
    }
  };

  const volInfo = friendlyVolatility(digitsData?.volatility.regime);
  const selectedMarketName =
    symbols.find((s) => s.symbol === selectedSymbol)?.display_name ||
    BEGINNER_MARKETS.find((m) => m.code === selectedSymbol)?.label ||
    selectedSymbol;

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
              Pick any market below to see live prices, digit patterns, trend direction, and plain-English AI guidance.
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
        {/* LEFT (7 cols): Live Analyser Dashboard */}
        <div className="flex flex-col justify-between space-y-4 rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27] lg:col-span-7">
          <div>
            {/* Live Price + Big Digit Tile + Verdict */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E5E9EF] pb-4 dark:border-[#243040]">
              <div>
                <div className="text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  {selectedMarketName} · Live Feed
                </div>
                <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#20242B] dark:text-white">
                  {displayQuote ?? 'Connecting…'}
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

            {/* Even/Odd & Over/Under Balance Bars */}
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-[#00A88F]">
                    Even {digitsData ? `${digitsData.analytics.evenPct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="text-[#0866FF]">
                    Odd {digitsData ? `${digitsData.analytics.oddPct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2.5 overflow-hidden rounded bg-[#E5E9EF] dark:bg-[#243040]">
                  <div
                    className="bg-[#00A88F]"
                    style={{ width: `${digitsData ? digitsData.analytics.evenPct : 50}%` }}
                  />
                  <div
                    className="bg-[#0866FF]"
                    style={{ width: `${digitsData ? digitsData.analytics.oddPct : 50}%` }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-[#08B9E6]">
                    Over 4 {digitsData ? `${digitsData.analytics.over4Pct.toFixed(1)}%` : '—'}
                  </span>
                  <span className="text-[#FF4D5A]">
                    Under 5 {digitsData ? `${digitsData.analytics.under5Pct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="mt-1.5 flex h-2.5 overflow-hidden rounded bg-[#E5E9EF] dark:bg-[#243040]">
                  <div
                    className="bg-[#08B9E6]"
                    style={{ width: `${digitsData ? digitsData.analytics.over4Pct : 50}%` }}
                  />
                  <div
                    className="bg-[#FF4D5A]"
                    style={{ width: `${digitsData ? digitsData.analytics.under5Pct : 50}%` }}
                  />
                </div>
              </div>
            </div>

            {/* 0–9 Simple Digit Frequency Bars */}
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                  Last-Digit Frequency (0–9) · Click any digit to test Differ
                </span>
                <span className="font-mono text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                  Expected Baseline: 10.0%
                </span>
              </div>

              <div className="mt-3 grid grid-cols-10 gap-1.5">
                {(sortedDigits.length === 10
                  ? sortedDigits
                  : Array.from({ length: 10 }, (_, d) => ({
                      digit: d,
                      percentage: 0,
                      count: 0,
                    }))
                ).map((row) => {
                  const isLatest = displayDigit === row.digit;
                  const isHighest = hottestDigit?.digit === row.digit && row.count > 0;
                  const isLowest = coldestDigit?.digit === row.digit && row.count > 0;
                  const barHeight = Math.min(100, Math.max(8, (row.percentage / 22) * 100));
                  return (
                    <button
                      key={row.digit}
                      type="button"
                      onClick={() => {
                        setPracticeDigit(row.digit);
                        setPracticeType('DIGITDIFF');
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
                Red bar = most common digit in this window · Green bar = least common digit. Past ticks do not guarantee future ticks.
              </p>
            </div>
          </div>

          {/* Live Last 20 Digits Tape */}
          <div className="border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
            <div className="mb-1.5 text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
              Live Tick Stream (Newest on right)
            </div>
            <div className="flex flex-wrap gap-1">
              {recentDigits.length === 0 ? (
                <span className="text-xs text-[#6B7280]">Waiting for incoming ticks…</span>
              ) : (
                recentDigits.map((item, idx) => {
                  const isNewest = idx === recentDigits.length - 1;
                  return (
                    <span
                      key={`${idx}-${item.quote}`}
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

        {/* RIGHT (5 cols): AI Analyst Brief + Safe 1-Click Paper Practice */}
        <div className="flex flex-col justify-between space-y-4 lg:col-span-5">
          {/* AI Analyst Brief (Gemini 4 Hydrogen) */}
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
                Click <strong>Ask AI Analyst</strong> to get a beginner-friendly plain-English breakdown of the live numbers on this screen.
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

          {/* 1-Click Safe Practice ($10,000 Paper Account) */}
          <div className="flex-1 rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  Practice Risk-Free
                </h2>
                <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  Virtual Balance:{' '}
                  <span className="font-mono font-bold tabular-nums text-[#00A88F]">
                    ${paperAccount ? paperAccount.current_equity.toFixed(2) : '10000.00'}
                  </span>
                </p>
              </div>
              <CheckCircle2 className="h-4 w-4 text-[#00A88F]" />
            </div>

            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1.5 text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  1. Choose Trade Type
                </div>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                  {(
                    [
                      { id: 'CALL', label: 'Rise' },
                      { id: 'PUT', label: 'Fall' },
                      { id: 'DIGITEVEN', label: 'Even' },
                      { id: 'DIGITODD', label: 'Odd' },
                      { id: 'DIGITDIFF', label: `Diff ${practiceDigit}` },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setPracticeType(opt.id)}
                      className={`rounded-md py-1.5 text-xs font-semibold transition ${
                        practiceType === opt.id
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

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="mb-1 text-xs font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                    2. Virtual Stake
                  </div>
                  <div className="flex gap-1.5">
                    {STAKE_PRESETS.map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setPracticeStake(amt)}
                        className={`rounded-md px-3 py-1.5 font-mono text-xs font-semibold tabular-nums ${
                          practiceStake === amt
                            ? 'bg-[#101820] text-white dark:bg-[#0866FF]'
                            : 'border border-[#E5E9EF] bg-[#F5F7FA] text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                        }`}
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-4">
                  <button
                    type="button"
                    disabled={practiceBusy}
                    onClick={handlePracticeTrade}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#00A88F] px-4 py-2 text-xs font-bold text-white hover:bg-[#00917b] disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    {practiceBusy ? 'Placing…' : 'Place Practice Trade'}
                  </button>
                </div>
              </div>

              {practiceMsg && (
                <div className="rounded-md bg-[#F5F7FA] px-3 py-2 text-xs text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]">
                  {practiceMsg}
                </div>
              )}

              {positions.length > 0 && (
                <div className="space-y-1.5 border-t border-[#E5E9EF] pt-2.5 dark:border-[#243040]">
                  <div className="text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                    Recent Practice Trades
                  </div>
                  {positions.map((pos) => (
                    <div
                      key={pos.position_id}
                      className="flex items-center justify-between rounded bg-[#F5F7FA] px-2.5 py-1.5 text-xs dark:bg-[#0F151D]"
                    >
                      <span className="font-medium text-[#20242B] dark:text-[#F3F4F6]">
                        {pos.contract_type} {pos.barrier ? `(${pos.barrier})` : ''} · ${pos.stake}
                      </span>
                      {pos.status === 'OPEN' ? (
                        <button
                          type="button"
                          onClick={() => void handleSettle(pos.position_id)}
                          className="rounded bg-[#0866FF] px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-[#0654d4]"
                        >
                          Settle
                        </button>
                      ) : (
                        <span
                          className={`font-mono font-bold tabular-nums ${
                            (pos.profit_loss ?? 0) >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                          }`}
                        >
                          {pos.status} {(pos.profit_loss ?? 0) >= 0 ? '+' : ''}
                          {(pos.profit_loss ?? 0).toFixed(2)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
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
