import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Crown,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type {
  ActiveSymbol,
  DerivSessionState,
  DigitsFullResponse,
  LiveDerivContract,
  LiveTickEvent,
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
}

type StrategyFilter = 'BEST' | 'DIGITMATCH' | 'DIGITDIFF';
type BotMode = 'MANUAL' | 'ASK' | 'AUTO';

interface RankedSignal {
  symbol: string;
  symbolLabel: string;
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  digit: number;
  score: number;
  strength: 'STRONG' | 'MODERATE' | 'WAIT';
  observedPct: number;
  avoidPct: number;
  lastSeenTicksAgo: number | null;
  payout: number | null;
  askPrice: number | null;
  reason: string;
}

interface BotTradeRecord {
  contractId: number;
  symbol: string;
  contractType: 'DIGITMATCH' | 'DIGITDIFF';
  digit: number;
  stake: number;
  status: 'open' | 'won' | 'lost' | 'sold';
  profit: number;
  entrySpot: string | null;
  exitSpot: string | null;
  isVirtual: boolean;
  timestamp: string;
}

const CORE_MARKETS: Array<{ code: string; label: string; shortLabel: string }> = [
  { code: '1HZ10V', label: 'Volatility 10 (1s)', shortLabel: 'V10 1s' },
  { code: '1HZ15V', label: 'Volatility 15 (1s)', shortLabel: 'V15 1s' },
  { code: '1HZ25V', label: 'Volatility 25 (1s)', shortLabel: 'V25 1s' },
  { code: '1HZ50V', label: 'Volatility 50 (1s)', shortLabel: 'V50 1s' },
  { code: '1HZ75V', label: 'Volatility 75 (1s)', shortLabel: 'V75 1s' },
  { code: '1HZ100V', label: 'Volatility 100 (1s)', shortLabel: 'V100 1s' },
  { code: 'R_10', label: 'Volatility 10', shortLabel: 'V10' },
  { code: 'R_25', label: 'Volatility 25', shortLabel: 'V25' },
  { code: 'R_50', label: 'Volatility 50', shortLabel: 'V50' },
  { code: 'R_75', label: 'Volatility 75', shortLabel: 'V75' },
  { code: 'R_100', label: 'Volatility 100', shortLabel: 'V100' },
];

const ENGINE_STEPS = [
  { id: 0, label: 'Data', icon: BarChart2 },
  { id: 1, label: 'Pattern', icon: Activity },
  { id: 2, label: 'Transitions', icon: Layers },
  { id: 3, label: 'Gaps', icon: Timer },
  { id: 4, label: 'Final', icon: TrendingUp },
] as const;

const MIN_STAKE_PRESETS = [0.35, 0.5, 1.0];
const BOT_SETTINGS_KEY = 'dqi_match_differ_bot_v2';

function marketNameFor(code: string, symbols: ActiveSymbol[]): string {
  return (
    symbols.find((s) => s.symbol === code)?.display_name ||
    CORE_MARKETS.find((m) => m.code === code)?.label ||
    code
  );
}

function scoreCandidatesFromDigits(
  symbol: string,
  symbolLabel: string,
  res: DigitsFullResponse,
  filter: StrategyFilter
): RankedSignal[] {
  const { analytics, volatility, proposals } = res;
  const latestDigit = analytics.latestObservedDigit;
  const volPenalty =
    volatility.regime === 'EXTREME' ? 12 : volatility.regime === 'HIGH' ? 4 : 0;

  const transitionMap = new Map<number, number>();
  for (const pair of analytics.transitionHotPairs) {
    if (latestDigit !== null && pair.from === latestDigit) {
      transitionMap.set(pair.to, pair.ratePct);
    }
  }

  const out: RankedSignal[] = [];

  for (const row of analytics.digits) {
    const gap = row.lastSeenTicksAgo ?? 10;
    const transPct = transitionMap.get(row.digit) ?? 10;

    if (filter === 'BEST' || filter === 'DIGITDIFF') {
      const underAvg = Math.max(-6, 10 - row.percentage);
      const transPenalty = Math.max(0, transPct - 12) * 1.1;
      const recentAbsenceBonus = gap >= 8 ? Math.min(8, (gap - 7) * 0.8) : gap <= 1 ? -4 : 0;
      const rawScore = 62 + underAvg * 4.2 + recentAbsenceBonus - transPenalty - volPenalty;
      const score = Math.max(15, Math.min(99, Math.round(rawScore)));
      const strength = score >= 80 ? 'STRONG' : score >= 65 ? 'MODERATE' : 'WAIT';
      out.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITDIFF',
        digit: row.digit,
        score,
        strength,
        observedPct: row.percentage,
        avoidPct: Number((100 - row.percentage).toFixed(1)),
        lastSeenTicksAgo: row.lastSeenTicksAgo,
        payout: proposals.differ?.payout ?? null,
        askPrice: proposals.differ?.askPrice ?? null,
        reason: `Digit ${row.digit} appeared ${row.percentage.toFixed(1)}% (${(100 - row.percentage).toFixed(1)}% differ rate) · last seen ${gap} ticks ago`,
      });
    }

    if (filter === 'BEST' || filter === 'DIGITMATCH') {
      const overAvg = Math.max(-5, row.percentage - 10);
      const transBonus = Math.max(0, transPct - 10) * 1.4;
      const gapCycleBonus = gap >= 6 && gap <= 16 ? 7 : 0;
      const rawScore = 54 + overAvg * 4.5 + transBonus + gapCycleBonus - volPenalty;
      const score = Math.max(15, Math.min(99, Math.round(rawScore)));
      const strength = score >= 80 ? 'STRONG' : score >= 65 ? 'MODERATE' : 'WAIT';
      out.push({
        symbol,
        symbolLabel,
        contractType: 'DIGITMATCH',
        digit: row.digit,
        score,
        strength,
        observedPct: row.percentage,
        avoidPct: Number((100 - row.percentage).toFixed(1)),
        lastSeenTicksAgo: row.lastSeenTicksAgo,
        payout: proposals.match?.payout ?? null,
        askPrice: proposals.match?.askPrice ?? null,
        reason: `Digit ${row.digit} hit ${row.percentage.toFixed(1)}% in sample · ${
          transPct > 12
            ? `Markov lift ${transPct.toFixed(0)}% after ${latestDigit}`
            : `last seen ${gap} ticks ago`
        }`,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
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
}) => {
  const savedCfg = useMemo(() => {
    try {
      const raw = window.localStorage.getItem(BOT_SETTINGS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }, []);

  const [scanMarkets, setScanMarkets] = useState<string[]>(() => {
    if (Array.isArray(savedCfg.scanMarkets) && savedCfg.scanMarkets.length > 0) {
      return savedCfg.scanMarkets.map(String);
    }
    return [selectedSymbol || '1HZ15V'];
  });

  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>(() =>
    savedCfg.strategyFilter === 'DIGITMATCH' || savedCfg.strategyFilter === 'DIGITDIFF'
      ? savedCfg.strategyFilter
      : 'BEST'
  );
  const [botMode, setBotMode] = useState<BotMode>('MANUAL');

  // Best Match/Differ stake & $10 drawdown protection settings
  const [minStake, setMinStake] = useState<number>(() =>
    typeof savedCfg.minStake === 'number' && savedCfg.minStake >= 0.35 ? savedCfg.minStake : 0.35
  );
  const [winStepAdd, setWinStepAdd] = useState<number>(() =>
    typeof savedCfg.winStepAdd === 'number' && savedCfg.winStepAdd >= 0 ? savedCfg.winStepAdd : 0.35
  );
  const [maxStakeCap, setMaxStakeCap] = useState<number>(() =>
    typeof savedCfg.maxStakeCap === 'number' && savedCfg.maxStakeCap >= 0.35 ? savedCfg.maxStakeCap : 2.0
  );
  const [maxDrawdown] = useState<number>(10.0);
  const [minScoreThreshold] = useState<number>(() =>
    typeof savedCfg.minScoreThreshold === 'number' ? savedCfg.minScoreThreshold : 74
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        BOT_SETTINGS_KEY,
        JSON.stringify({
          scanMarkets,
          strategyFilter,
          minStake,
          winStepAdd,
          maxStakeCap,
          minScoreThreshold,
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [scanMarkets, strategyFilter, minStake, winStepAdd, maxStakeCap, minScoreThreshold]);

  // Live digit feed state for the currently focused symbol
  const [digitsData, setDigitsData] = useState<DigitsFullResponse | null>(null);
  const [syncingData, setSyncingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // 5-phase scanner state
  const [scanning, setScanning] = useState(false);
  const [scanPhaseIdx, setScanPhaseIdx] = useState<number>(4);
  const [lastAnalysisTime, setLastAnalysisTime] = useState<string | null>(null);
  const [rankedSignals, setRankedSignals] = useState<RankedSignal[]>([]);
  const [lockedSignal, setLockedSignal] = useState<RankedSignal | null>(null);
  const [askPromptSignal, setAskPromptSignal] = useState<RankedSignal | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [realAccountOptIn, setRealAccountOptIn] = useState(false);

  // Bot session progress & 2-win streak / min-loss tracker
  const [sessionAccountId, setSessionAccountId] = useState<string | null>(null);
  const [sessionStartBalance, setSessionStartBalance] = useState<number | null>(null);
  const [sessionPeakBalance, setSessionPeakBalance] = useState<number | null>(null);
  const [consecutiveWins, setConsecutiveWins] = useState(0);
  const [currentStake, setCurrentStake] = useState<number>(minStake);
  const [sessionTrades, setSessionTrades] = useState<BotTradeRecord[]>([]);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const processedContractsRef = useRef<Set<number>>(new Set());

  // Sync session start/peak balance when Deriv account connects or switches
  useEffect(() => {
    if (!derivSession.connected || derivSession.activeBalance === null) return;
    if (sessionAccountId !== derivSession.activeLoginId) {
      setSessionAccountId(derivSession.activeLoginId);
      setSessionStartBalance(derivSession.activeBalance);
      setSessionPeakBalance(derivSession.activeBalance);
      setConsecutiveWins(0);
      setCurrentStake(minStake);
      setRealAccountOptIn(false);
      setAutoRunning(false);
      setAskPromptSignal(null);
      return;
    }
    setSessionPeakBalance((prev) =>
      prev === null ? derivSession.activeBalance : Math.max(prev, derivSession.activeBalance!)
    );
  }, [derivSession.connected, derivSession.activeLoginId, derivSession.activeBalance, sessionAccountId, minStake]);

  useEffect(() => {
    if (consecutiveWins < 2) {
      setCurrentStake(minStake);
    }
  }, [minStake, consecutiveWins]);

  // Compute live session metrics & $10 drawdown guard
  const settledTrades = useMemo(
    () => sessionTrades.filter((t) => t.status === 'won' || t.status === 'lost' || t.status === 'sold'),
    [sessionTrades]
  );
  const winsCount = useMemo(() => settledTrades.filter((t) => t.profit > 0).length, [settledTrades]);
  const lossesCount = useMemo(() => settledTrades.filter((t) => t.profit <= 0).length, [settledTrades]);
  const sessionRealizedPnl = useMemo(
    () => Number(settledTrades.reduce((sum, t) => sum + t.profit, 0).toFixed(2)),
    [settledTrades]
  );

  const balanceDrawdown =
    derivSession.connected &&
    derivSession.activeBalance !== null &&
    sessionPeakBalance !== null
      ? Math.max(0, Number((sessionPeakBalance - derivSession.activeBalance).toFixed(2)))
      : 0;
  const pnlDrawdown = Math.max(0, Number((-sessionRealizedPnl).toFixed(2)));
  const drawdownUsed = Math.max(balanceDrawdown, pnlDrawdown);
  const drawdownRemaining = Math.max(0, Number((maxDrawdown - drawdownUsed).toFixed(2)));
  const drawdownLocked = drawdownUsed >= maxDrawdown || drawdownRemaining < 0.35;

  const effectiveNextStake = useMemo(() => {
    if (drawdownLocked) return 0;
    const capped = Math.min(currentStake, maxStakeCap, drawdownRemaining);
    return Math.max(0.35, Number(capped.toFixed(2)));
  }, [currentStake, maxStakeCap, drawdownRemaining, drawdownLocked]);

  const [liveProposal, setLiveProposal] = useState<{ askPrice: number; payout: number } | null>(null);

  const activeContractType: 'DIGITMATCH' | 'DIGITDIFF' =
    lockedSignal?.contractType ?? (strategyFilter === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF');
  const activeDigit = lockedSignal?.digit ?? 0;

  useEffect(() => {
    if (drawdownLocked) return;
    let cancelled = false;
    void dqiApi
      .getProposal({
        symbol: lockedSignal?.symbol || selectedSymbol,
        contractType: activeContractType,
        amount: effectiveNextStake || minStake,
        duration: 1,
        durationUnit: 't',
        barrier: String(activeDigit),
      })
      .then((p) => {
        if (!cancelled) setLiveProposal({ askPrice: p.askPrice, payout: p.payout });
      })
      .catch(() => {
        if (!cancelled) setLiveProposal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [lockedSignal?.symbol, selectedSymbol, activeContractType, activeDigit, effectiveNextStake, minStake, drawdownLocked]);

  // Sync live 100-tick history for selected symbol
  const syncSelectedSymbolData = useCallback(async () => {
    setSyncingData(true);
    setDataError(null);
    try {
      const res = await dqiApi.analyzeDigits(selectedSymbol, 100, minStake, 1);
      setDigitsData(res);
      const ranked = scoreCandidatesFromDigits(
        selectedSymbol,
        marketNameFor(selectedSymbol, symbols),
        res,
        strategyFilter
      );
      if (ranked.length > 0) {
        setRankedSignals(ranked);
        setLockedSignal(ranked[0]);
        setLastAnalysisTime(new Date().toLocaleTimeString());
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Waiting for Deriv live quotes...');
    } finally {
      setSyncingData(false);
    }
  }, [selectedSymbol, minStake, symbols, strategyFilter]);

  useEffect(() => {
    let cancelled = false;
    void dqiApi
      .analyzeDigits(selectedSymbol, 100, minStake, 1)
      .then((res) => {
        if (!cancelled) {
          setDigitsData(res);
          setDataError(null);
          const ranked = scoreCandidatesFromDigits(
            selectedSymbol,
            marketNameFor(selectedSymbol, symbols),
            res,
            strategyFilter
          );
          if (ranked.length > 0) {
            setRankedSignals(ranked);
            setLockedSignal((prev) => (!prev || prev.symbol !== selectedSymbol ? ranked[0] : prev));
            setLastAnalysisTime((prev) => prev || new Date().toLocaleTimeString());
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDataError(err instanceof Error ? err.message : 'Waiting for Deriv live quotes...');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, minStake, strategyFilter, symbols]);

  const liveDigits = useMemo(() => {
    const base = (digitsData?.analytics.tape ?? []).map((t) => ({
      digit: t.digit,
      quote: t.quote,
      epoch: t.epoch,
    }));
    const live = liveTapeBuffer.map((t) => ({
      digit: t.lastDigit,
      quote: t.rawQuote,
      epoch: t.epoch,
    }));
    const seen = new Set<string>();
    const merged: Array<{ digit: number; quote: string; epoch: number }> = [];
    for (const item of [...base, ...live]) {
      const k = `${item.epoch}:${item.quote}`;
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(item);
      }
    }
    const win = merged.slice(-100);
    const counts = new Array<number>(10).fill(0);
    for (const row of win) counts[row.digit] += 1;
    const total = win.length;
    return {
      total,
      bars: counts.map((c, digit) => ({
        digit,
        count: c,
        pct: total > 0 ? (c / total) * 100 : 0,
      })),
      tape20: win.slice(-20),
    };
  }, [digitsData, liveTapeBuffer]);

  // Watch liveContracts for settlement -> 2-win stake booster / min-loss reset
  useEffect(() => {
    if (liveContracts.length === 0) return;

    setSessionTrades((prev) =>
      prev.map((tr) => {
        const live = liveContracts.find((c) => c.contractId === tr.contractId);
        if (!live) return tr;
        return {
          ...tr,
          status: live.status,
          profit: live.profit,
          entrySpot: live.entrySpot,
          exitSpot: live.currentSpot,
        };
      })
    );

    for (const live of liveContracts) {
      const tracked = sessionTrades.find((t) => t.contractId === live.contractId);
      if (!tracked) continue;
      if (live.status === 'open' || processedContractsRef.current.has(live.contractId)) continue;

      processedContractsRef.current.add(live.contractId);
      if (live.profit > 0) {
        setConsecutiveWins((prevStreak) => {
          const nextStreak = prevStreak + 1;
          if (nextStreak >= 2 && nextStreak % 2 === 0) {
            setCurrentStake((prevStake) => {
              const boosted = Math.min(maxStakeCap, Number((prevStake + winStepAdd).toFixed(2)));
              setStatusMessage(
                `2 consecutive wins! Stake boosted to $${boosted.toFixed(2)} (+$${winStepAdd.toFixed(2)}).`
              );
              return boosted;
            });
          } else {
            setStatusMessage(
              `Win #${nextStreak} (+$${live.profit.toFixed(2)}). 1 more consecutive win to add stake.`
            );
          }
          return nextStreak;
        });
      } else {
        setConsecutiveWins(0);
        setCurrentStake(minStake);
        setStatusMessage(
          `Loss ($${live.profit.toFixed(2)}). Stake reset immediately to minimum $${minStake.toFixed(2)} to avoid $10 drawdown.`
        );
      }
    }
  }, [liveContracts, sessionTrades, maxStakeCap, winStepAdd, minStake]);

  // Execute 5-step Deep Analysis ONLY across user's selected scanMarkets
  const runTargetedScan = useCallback(async (): Promise<RankedSignal | null> => {
    const targets = scanMarkets.length > 0 ? scanMarkets : [selectedSymbol];
    setScanning(true);
    setScanPhaseIdx(0);
    setDataError(null);

    try {
      const allRanked: RankedSignal[] = [];

      for (let idx = 0; idx < targets.length; idx += 1) {
        const sym = targets[idx];
        setScanPhaseIdx(0);
        const res = await dqiApi.analyzeDigits(sym, 100, effectiveNextStake || minStake, 1);
        setScanPhaseIdx(1);
        await new Promise((r) => window.setTimeout(r, 90));
        setScanPhaseIdx(2);
        await new Promise((r) => window.setTimeout(r, 90));
        setScanPhaseIdx(3);
        const candidates = scoreCandidatesFromDigits(
          sym,
          marketNameFor(sym, symbols),
          res,
          strategyFilter
        );
        if (candidates.length > 0) {
          allRanked.push(...candidates.slice(0, 4));
        }
        if (sym === selectedSymbol) {
          setDigitsData(res);
        }
      }

      setScanPhaseIdx(4);
      allRanked.sort((a, b) => b.score - a.score);
      setRankedSignals(allRanked);

      const best = allRanked[0] ?? null;
      if (best) {
        setLockedSignal(best);
        setLastAnalysisTime(new Date().toLocaleTimeString());
        if (best.symbol !== selectedSymbol) {
          onSelectSymbol(best.symbol);
        }
      }
      return best;
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Scan failed — check Deriv connection');
      return null;
    } finally {
      setScanning(false);
    }
  }, [scanMarkets, selectedSymbol, effectiveNextStake, minStake, symbols, strategyFilter, onSelectSymbol]);

  const executeTradeSignal = useCallback(
    async (signal: RankedSignal) => {
      if (!derivSession.connected) {
        onOpenConnect();
        return;
      }
      if (drawdownLocked) {
        setAutoRunning(false);
        setStatusMessage('Stopped: $10.00 session drawdown limit reached. Reset session to resume.');
        return;
      }
      if (!derivSession.activeIsVirtual && !realAccountOptIn) {
        setStatusMessage('Tick the Real Account safety confirmation checkbox before placing a live trade.');
        return;
      }

      const stakeToUse = effectiveNextStake;
      if (stakeToUse < 0.35 || stakeToUse > drawdownRemaining) {
        setAutoRunning(false);
        setStatusMessage('Trade blocked to protect your $10.00 drawdown limit.');
        return;
      }

      setTradeBusy(true);
      setAskPromptSignal(null);
      setStatusMessage(null);
      try {
        const contract = await dqiApi.buyDerivContract({
          symbol: signal.symbol,
          contractType: signal.contractType,
          amount: stakeToUse,
          duration: 1,
          durationUnit: 't',
          barrier: String(signal.digit),
        });

        setSessionTrades((prev) => [
          {
            contractId: contract.contractId,
            symbol: signal.symbol,
            contractType: signal.contractType,
            digit: signal.digit,
            stake: contract.buyPrice || stakeToUse,
            status: contract.status,
            profit: contract.profit,
            entrySpot: contract.entrySpot,
            exitSpot: contract.currentSpot,
            isVirtual: contract.isVirtual,
            timestamp: new Date().toLocaleTimeString(),
          },
          ...prev.slice(0, 29),
        ]);
        setStatusMessage(
          `Placed ${signal.contractType === 'DIGITMATCH' ? 'Matches' : 'Differs'} Digit ${signal.digit} ($${stakeToUse.toFixed(2)}) on ${signal.symbolLabel}.`
        );
      } catch (err) {
        setStatusMessage(err instanceof Error ? err.message : 'Order rejected by Deriv');
        setAutoRunning(false);
      } finally {
        setTradeBusy(false);
      }
    },
    [
      derivSession.connected,
      derivSession.activeIsVirtual,
      drawdownLocked,
      realAccountOptIn,
      effectiveNextStake,
      drawdownRemaining,
      onOpenConnect,
    ]
  );

  const hasOpenBotTrade = useMemo(() => sessionTrades.some((t) => t.status === 'open'), [sessionTrades]);

  useEffect(() => {
    if (!autoRunning) return;
    if (botMode === 'MANUAL' || drawdownLocked) {
      setAutoRunning(false);
      return;
    }
    if (botMode === 'ASK' && askPromptSignal) return;
    if (tradeBusy || hasOpenBotTrade || scanning) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        const best = await runTargetedScan();
        if (!best) return;
        if (best.score < minScoreThreshold) {
          setStatusMessage(
            `Scanned ${scanMarkets.join(', ')}: confidence ${best.score}% < ${minScoreThreshold}% threshold. Waiting…`
          );
          return;
        }
        if (botMode === 'ASK') {
          setAskPromptSignal(best);
        } else if (botMode === 'AUTO') {
          await executeTradeSignal(best);
        }
      })();
    }, 3500);

    return () => window.clearTimeout(timer);
  }, [
    autoRunning,
    botMode,
    drawdownLocked,
    askPromptSignal,
    tradeBusy,
    hasOpenBotTrade,
    scanning,
    minScoreThreshold,
    scanMarkets,
    runTargetedScan,
    executeTradeSignal,
  ]);

  const toggleMarketInWatchlist = (code: string) => {
    setScanMarkets((prev) => {
      if (prev.includes(code)) {
        if (prev.length === 1) return prev;
        const next = prev.filter((m) => m !== code);
        if (selectedSymbol === code) onSelectSymbol(next[0]);
        return next;
      }
      const next = [...prev, code];
      onSelectSymbol(code);
      return next;
    });
  };

  const resetSessionProgress = () => {
    setSessionStartBalance(derivSession.activeBalance);
    setSessionPeakBalance(derivSession.activeBalance);
    setConsecutiveWins(0);
    setCurrentStake(minStake);
    setSessionTrades([]);
    processedContractsRef.current.clear();
    setAutoRunning(false);
    setAskPromptSignal(null);
    setStatusMessage('Session reset. Stake back at minimum and $10 drawdown guard cleared.');
  };

  const displayQuote = latestTick?.rawQuote ?? digitsData?.analytics.latestQuote ?? null;
  const displayDigit = latestTick?.lastDigit ?? digitsData?.analytics.latestObservedDigit ?? null;
  const quotePrefix = displayQuote && displayQuote.length > 1 ? displayQuote.slice(0, -1) : '';
  const quoteLastChar = displayQuote ? displayQuote.slice(-1) : '';

  const drawdownPct = Math.min(100, (drawdownUsed / maxDrawdown) * 100);
  const potentialReturn =
    liveProposal && liveProposal.askPrice > 0
      ? Number((liveProposal.payout - liveProposal.askPrice).toFixed(2))
      : null;

  const confidencePct = lockedSignal?.score ?? 0;

  return (
    <div className="space-y-4">
      {dataError && (
        <div className="rounded-lg border border-[#FF444F]/40 bg-[#FF444F]/10 px-4 py-2.5 text-xs text-[#FF444F]">
          {dataError}
        </div>
      )}

      {/* Main Layout: Left Mirrors the Clean Vertical Analysis Screenshot Flow; Right Holds Bot & Account Progress */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        {/* LEFT COLUMN (7 cols): Market Selector -> 5-Step Analysis Engine -> Centered Prediction Hero -> Market Stats */}
        <div className="space-y-4 lg:col-span-7">
          {/* 1. MARKET SELECTOR CARD */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-[#0866FF]" />
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  Market Selector
                </h2>
              </div>

              {/* Strategy Segmented Toggle */}
              <div className="flex items-center rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-0.5 dark:border-[#243040] dark:bg-[#0F151D]">
                {(
                  [
                    { id: 'BEST', label: 'Best (M+D)' },
                    { id: 'DIGITMATCH', label: 'Matches' },
                    { id: 'DIGITDIFF', label: 'Differs' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setStrategyFilter(opt.id)}
                    className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition ${
                      strategyFilter === opt.id
                        ? 'bg-[#0866FF] text-white'
                        : 'text-[#6B7280] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Primary Market Dropdown */}
            <div className="mt-3">
              <select
                aria-label="Select primary market to scan"
                value={selectedSymbol}
                onChange={(e) => {
                  const code = e.target.value;
                  onSelectSymbol(code);
                  if (!scanMarkets.includes(code)) {
                    setScanMarkets([code]);
                  }
                }}
                className="w-full rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2.5 text-sm font-semibold text-[#20242B] outline-none focus:border-[#0866FF] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
              >
                {CORE_MARKETS.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.shortLabel} — {m.label} ({m.code})
                  </option>
                ))}
                {symbols
                  .filter((s) => !CORE_MARKETS.some((m) => m.code === s.symbol))
                  .map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.display_name} ({s.symbol})
                    </option>
                  ))}
              </select>
            </div>

            {/* 2 Clean Action Buttons matching Screenshot (Sync Data + Run Deep Analysis) */}
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={syncingData || scanning}
                onClick={() => void syncSelectedSymbolData()}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-4 py-2 text-xs font-semibold text-[#20242B] hover:border-[#0866FF] disabled:opacity-50 dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncingData ? 'animate-spin text-[#0866FF]' : ''}`} />
                {syncingData ? 'Syncing…' : 'Sync Data'}
              </button>

              <button
                type="button"
                disabled={scanning}
                onClick={() => void runTargetedScan()}
                className="inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#0866FF] px-5 py-2 text-xs font-bold text-white hover:bg-[#0654d4] disabled:opacity-50 sm:flex-none"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                {scanning ? 'Running Deep Analysis…' : 'Run Deep Analysis'}
              </button>
            </div>

            {/* User-Chosen Bot Scan Watchlist (never scans random markets) */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
              <span className="mr-1 text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                Scan Watchlist:
              </span>
              {CORE_MARKETS.slice(0, 6).map((m) => {
                const included = scanMarkets.includes(m.code);
                return (
                  <button
                    key={m.code}
                    type="button"
                    onClick={() => toggleMarketInWatchlist(m.code)}
                    className={`whitespace-nowrap rounded px-2 py-1 text-[11px] font-semibold transition ${
                      included
                        ? 'bg-[#0866FF] text-white'
                        : 'bg-[#F5F7FA] text-[#6B7280] hover:text-[#20242B] dark:bg-[#0F151D] dark:text-[#9CA3AF] dark:hover:text-white'
                    }`}
                  >
                    {m.shortLabel}
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2. 5-STEP ANALYSIS ENGINE STRIP (Mirrors screenshot's 5 horizontal engine blocks) */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#0866FF]" />
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  DQI Analysis Engine
                </h2>
              </div>
              <span className="font-mono text-xs font-semibold tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                {scanning ? `Phase ${scanPhaseIdx + 1}/5` : lockedSignal ? '5/5 Complete' : 'Ready'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-5 gap-2">
              {ENGINE_STEPS.map((step) => {
                const Icon = step.icon;
                const isDone = !scanning && Boolean(lockedSignal);
                const isCurrent = scanning && scanPhaseIdx === step.id;
                const isCompletedStep = scanning ? scanPhaseIdx > step.id : isDone;
                return (
                  <div
                    key={step.id}
                    className={`flex flex-col items-center justify-center rounded-md border px-2 py-2.5 text-center transition ${
                      isCurrent
                        ? 'border-[#0866FF] bg-[#0866FF] text-white'
                        : isCompletedStep
                        ? 'border-[#00A88F]/40 bg-[#00A88F]/10 text-[#00A88F]'
                        : 'border-[#E5E9EF] bg-[#F5F7FA] text-[#6B7280] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#9CA3AF]'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="mt-1 text-[11px] font-semibold leading-tight">
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Completion Summary Line matching screenshot */}
            <div className="mt-3 flex items-center gap-2 text-xs font-medium text-[#20242B] dark:text-[#F3F4F6]">
              <CheckCircle2
                className={`h-4 w-4 shrink-0 ${
                  scanning ? 'text-[#0866FF]' : lockedSignal ? 'text-[#00A88F]' : 'text-[#6B7280]'
                }`}
              />
              <span>
                {scanning
                  ? `Scanning ${scanMarkets.join(', ')} — Step ${scanPhaseIdx + 1} of 5…`
                  : lockedSignal
                  ? `Analysis Complete! Prediction: ${
                      lockedSignal.contractType === 'DIGITMATCH' ? 'Matches' : 'Differs'
                    } Digit ${lockedSignal.digit} with ${lockedSignal.score}% confidence`
                  : 'Click Run Deep Analysis to evaluate your chosen market(s).'}
              </span>
            </div>
          </section>

          {/* 3. CENTERED PREDICTION HERO CARD (Mirrors PlusPro AI Prediction Card) */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="rounded-lg border border-[#E5E9EF] bg-[#F5F7FA] px-5 py-6 text-center dark:border-[#243040] dark:bg-[#0F151D]">
              <div className="flex justify-center">
                <Crown
                  className={`h-7 w-7 ${
                    activeContractType === 'DIGITMATCH' ? 'text-[#00A88F]' : 'text-[#0866FF]'
                  }`}
                />
              </div>

              <div className="mt-2 text-sm font-bold text-[#20242B] dark:text-white">
                DQI Signal Prediction ·{' '}
                <span
                  className={
                    activeContractType === 'DIGITMATCH' ? 'text-[#00A88F]' : 'text-[#0866FF]'
                  }
                >
                  {activeContractType === 'DIGITMATCH' ? 'Digit Matches' : 'Digit Differs'}
                </span>
              </div>

              {/* Giant Centered Predicted Digit */}
              <div className="mt-3 font-mono text-6xl font-bold leading-none tabular-nums text-[#20242B] dark:text-white">
                {lockedSignal ? lockedSignal.digit : '—'}
              </div>

              {/* Confidence Progress Bar */}
              <div className="mx-auto mt-4 max-w-sm">
                <div className="h-2.5 overflow-hidden rounded-full bg-[#E5E9EF] dark:bg-[#243040]">
                  <div
                    className={`h-full transition-all duration-300 ${
                      confidencePct >= 80
                        ? 'bg-[#00A88F]'
                        : confidencePct >= 65
                        ? 'bg-[#0866FF]'
                        : 'bg-[#FFAD3A]'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(4, confidencePct))}%` }}
                  />
                </div>
              </div>

              <div className="mt-3 text-sm font-bold tabular-nums text-[#20242B] dark:text-white">
                Confidence: {lockedSignal ? `${confidencePct}%` : '—'}
              </div>

              <div className="mt-1 font-mono text-xs tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                Last Analysis: {lastAnalysisTime || 'Pending'}
                {lockedSignal ? ` · ${lockedSignal.symbolLabel}` : ''}
              </div>

              {lockedSignal && (
                <div className="mt-2 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  {lockedSignal.reason}
                </div>
              )}

              {/* Quick Top-3 Signal Switcher when scan evaluated multiple picks */}
              {rankedSignals.length > 1 && !scanning && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {rankedSignals.slice(0, 3).map((cand) => {
                    const isPicked =
                      lockedSignal?.symbol === cand.symbol &&
                      lockedSignal?.contractType === cand.contractType &&
                      lockedSignal?.digit === cand.digit;
                    return (
                      <button
                        key={`${cand.symbol}-${cand.contractType}-${cand.digit}`}
                        type="button"
                        onClick={() => {
                          setLockedSignal(cand);
                          if (cand.symbol !== selectedSymbol) onSelectSymbol(cand.symbol);
                        }}
                        className={`rounded px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums transition ${
                          isPicked
                            ? 'bg-[#0866FF] text-white'
                            : 'border border-[#E5E9EF] bg-white text-[#20242B] hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27] dark:text-[#F3F4F6]'
                        }`}
                      >
                        {cand.contractType === 'DIGITMATCH' ? 'MATCH' : 'DIFF'} {cand.digit} ({cand.score}%)
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Live Tick Feed + Clickable 0-9 Bars */}
            <div className="mt-4 border-t border-[#E5E9EF] pt-4 dark:border-[#243040]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                    {marketNameFor(selectedSymbol, symbols)} · Live Tick ({liveDigits.total} ticks)
                  </div>
                  <div className="mt-0.5 font-mono text-2xl font-bold tabular-nums text-[#20242B] dark:text-white">
                    {displayQuote ? (
                      <>
                        <span>{quotePrefix}</span>
                        <span className="ml-0.5 rounded bg-[#0866FF] px-1.5 py-0.5 text-white">
                          {quoteLastChar}
                        </span>
                      </>
                    ) : (
                      'Connecting…'
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-right font-mono text-xs tabular-nums">
                  <div>
                    <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Entropy</div>
                    <div className="font-bold text-[#20242B] dark:text-white">
                      {digitsData ? `${digitsData.analytics.entropyBits.toFixed(2)} b` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Speed</div>
                    <div className="font-bold text-[#20242B] dark:text-white">
                      {digitsData?.volatility.regime || 'LIVE'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Interactive 0–9 Frequency Strip */}
              <div className="mt-3 grid grid-cols-10 gap-1.5">
                {liveDigits.bars.map((bar) => {
                  const isTarget = activeDigit === bar.digit;
                  const isLatest = displayDigit === bar.digit;
                  const height = Math.min(100, Math.max(10, (bar.pct / 22) * 100));
                  return (
                    <button
                      key={bar.digit}
                      type="button"
                      onClick={() => {
                        const modeType: 'DIGITMATCH' | 'DIGITDIFF' =
                          strategyFilter === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF';
                        setLockedSignal({
                          symbol: selectedSymbol,
                          symbolLabel: marketNameFor(selectedSymbol, symbols),
                          contractType: lockedSignal?.contractType || modeType,
                          digit: bar.digit,
                          score: lockedSignal?.score ?? 75,
                          strength: 'MODERATE',
                          observedPct: bar.pct,
                          avoidPct: Number((100 - bar.pct).toFixed(1)),
                          lastSeenTicksAgo: null,
                          payout: liveProposal?.payout ?? null,
                          askPrice: liveProposal?.askPrice ?? null,
                          reason: `Manual digit ${bar.digit} selected (${bar.pct.toFixed(1)}% in last ${liveDigits.total} ticks)`,
                        });
                      }}
                      className={`flex flex-col items-center rounded-md border p-1 transition ${
                        isTarget
                          ? 'border-[#0866FF] bg-[#0866FF]/10 ring-1 ring-[#0866FF]'
                          : isLatest
                          ? 'border-[#00A88F] bg-[#00A88F]/8'
                          : 'border-[#E5E9EF] bg-[#F5F7FA] hover:border-[#0866FF]/50 dark:border-[#243040] dark:bg-[#0F151D]'
                      }`}
                    >
                      <span className="font-mono text-[10px] tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                        {bar.pct.toFixed(0)}%
                      </span>
                      <div className="my-1 flex h-12 w-full items-end justify-center">
                        <div
                          className={`w-2.5 rounded-t ${
                            isTarget
                              ? 'bg-[#0866FF]'
                              : isLatest
                              ? 'bg-[#00A88F]'
                              : 'bg-[#6B7280]/50 dark:bg-[#9CA3AF]/40'
                          }`}
                          style={{ height: `${height}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs font-bold tabular-nums text-[#20242B] dark:text-white">
                        {bar.digit}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Latest 20 Digits Tape */}
              {liveDigits.tape20.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1">
                  {liveDigits.tape20.map((t, idx) => {
                    const isNewest = idx === liveDigits.tape20.length - 1;
                    return (
                      <span
                        key={`${t.epoch}-${idx}`}
                        className={`flex h-6 w-6 items-center justify-center rounded font-mono text-[11px] font-bold tabular-nums ${
                          isNewest
                            ? 'bg-[#0866FF] text-white'
                            : t.digit === activeDigit
                            ? 'bg-[#00A88F]/20 text-[#00A88F]'
                            : 'bg-[#F5F7FA] text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]'
                        }`}
                      >
                        {t.digit}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 4. CURRENT MARKET STATS FOOTER LINE (Mirrors bottom of screenshot) */}
            <div className="mt-4 border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
              <div className="flex items-center gap-1.5 text-xs font-bold text-[#0866FF]">
                <BarChart2 className="h-3.5 w-3.5" />
                <span>Current Market Stats</span>
              </div>
              <div className="mt-1 font-mono text-xs tabular-nums text-[#20242B] dark:text-[#F3F4F6]">
                Predicted Digit: <strong>{lockedSignal ? lockedSignal.digit : '—'}</strong> | Confidence:{' '}
                <strong>{lockedSignal ? `${confidencePct}%` : '—'}</strong> | Latest Tick:{' '}
                <strong>{displayDigit !== null ? displayDigit : '—'}</strong>
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN (5 cols): Account Progress + $10 Drawdown Guard + Controlled Match/Differ Bot */}
        <div className="space-y-4 lg:col-span-5">
          {/* Account Progress & $10.00 Drawdown Protection */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  Account Progress
                </h2>
                <div className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  {derivSession.connected
                    ? `${derivSession.activeIsVirtual ? 'Demo' : 'Real'} (${derivSession.activeLoginId})`
                    : 'Connect Deriv to track live balance'}
                </div>
              </div>
              <button
                type="button"
                onClick={resetSessionProgress}
                className="inline-flex items-center gap-1 rounded border border-[#E5E9EF] px-2.5 py-1 text-[11px] font-semibold text-[#6B7280] hover:text-[#20242B] dark:border-[#243040] dark:text-[#9CA3AF] dark:hover:text-white"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 rounded-md bg-[#F5F7FA] p-3 font-mono text-xs tabular-nums dark:bg-[#0F151D]">
              <div>
                <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Session P&amp;L</div>
                <div
                  className={`mt-0.5 text-sm font-bold ${
                    sessionRealizedPnl >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                  }`}
                >
                  {sessionRealizedPnl >= 0 ? '+' : ''}${sessionRealizedPnl.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Win / Loss</div>
                <div className="mt-0.5 text-sm font-bold text-[#20242B] dark:text-white">
                  {winsCount}W / {lossesCount}L
                </div>
              </div>
              <div>
                <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Win Streak</div>
                <div className="mt-0.5 text-sm font-bold text-[#0866FF]">
                  {consecutiveWins} {consecutiveWins >= 2 ? '(Boosted)' : '/ 2'}
                </div>
              </div>
            </div>

            {/* $10.00 Drawdown Safety Meter */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                  <ShieldCheck className="h-3.5 w-3.5 text-[#00A88F]" />
                  $10.00 Drawdown Protection
                </span>
                <span className="font-mono text-xs font-bold tabular-nums text-[#20242B] dark:text-white">
                  ${drawdownUsed.toFixed(2)} / ${maxDrawdown.toFixed(2)}
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded bg-[#E5E9EF] dark:bg-[#243040]">
                <div
                  className={`h-full transition-all ${
                    drawdownPct >= 80
                      ? 'bg-[#FF444F]'
                      : drawdownPct >= 50
                      ? 'bg-[#FFAD3A]'
                      : 'bg-[#00A88F]'
                  }`}
                  style={{ width: `${drawdownPct}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                <span>Safe buffer left: ${drawdownRemaining.toFixed(2)}</span>
                <span>
                  Start: {sessionStartBalance !== null ? `$${sessionStartBalance.toFixed(2)}` : '—'}
                </span>
              </div>
            </div>
          </section>

          {/* Controlled Match & Differ Bot */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                Match &amp; Differ Bot
              </h2>
              <span className="font-mono text-xs font-bold tabular-nums text-[#0866FF]">
                Next Stake: ${effectiveNextStake.toFixed(2)}
              </span>
            </div>

            {/* Bot Execution Mode Switch (Manual / Ask Me / Auto Bot) */}
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex flex-1 items-center rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-0.5 dark:border-[#243040] dark:bg-[#0F151D]">
                {(
                  [
                    { id: 'MANUAL', label: 'Manual' },
                    { id: 'ASK', label: 'Ask Me' },
                    { id: 'AUTO', label: 'Auto Bot' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setBotMode(m.id);
                      if (m.id === 'MANUAL') {
                        setAutoRunning(false);
                        setAskPromptSignal(null);
                      }
                    }}
                    className={`flex-1 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-semibold transition ${
                      botMode === m.id
                        ? 'bg-[#101820] text-white dark:bg-[#0866FF]'
                        : 'text-[#6B7280] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {botMode !== 'MANUAL' && (
                <button
                  type="button"
                  disabled={drawdownLocked}
                  onClick={() => {
                    if (autoRunning) {
                      setAutoRunning(false);
                    } else {
                      setAutoRunning(true);
                      void runTargetedScan();
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${
                    autoRunning
                      ? 'bg-[#FF444F] hover:bg-[#e53843]'
                      : 'bg-[#00A88F] hover:bg-[#00917b]'
                  }`}
                >
                  {autoRunning ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {autoRunning ? 'Stop' : 'Start'}
                </button>
              )}
            </div>

            {/* 3 Clean Stake & Protection Inputs */}
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Min Stake ($)
                </label>
                <div className="mt-1 flex gap-1">
                  {MIN_STAKE_PRESETS.map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setMinStake(amt)}
                      className={`flex-1 rounded py-1 font-mono text-[11px] font-semibold tabular-nums ${
                        minStake === amt
                          ? 'bg-[#101820] text-white dark:bg-[#0866FF]'
                          : 'border border-[#E5E9EF] bg-[#F5F7FA] text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white'
                      }`}
                    >
                      ${amt}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  +Add After 2 Wins
                </label>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  max={5}
                  value={winStepAdd}
                  onChange={(e) => setWinStepAdd(Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Max Stake Cap
                </label>
                <input
                  type="number"
                  step="0.25"
                  min={0.35}
                  max={5}
                  value={maxStakeCap}
                  onChange={(e) => setMaxStakeCap(Math.max(0.35, Number(e.target.value)))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                />
              </div>
            </div>

            <div className="mt-2 text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
              Win 2x consecutively → adds +${winStepAdd.toFixed(2)} · Loss → resets to ${minStake.toFixed(2)} min stake.
            </div>

            {/* Ask-Me Confirmation Banner */}
            {askPromptSignal && !drawdownLocked && (
              <div className="mt-3 rounded-md border border-[#0866FF] bg-[#0866FF]/10 p-3 text-xs">
                <div className="font-bold text-[#20242B] dark:text-white">
                  Signal Ready: {askPromptSignal.contractType === 'DIGITMATCH' ? 'Matches' : 'Differs'} Digit{' '}
                  {askPromptSignal.digit} on {askPromptSignal.symbolLabel} ({askPromptSignal.score}%)
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={tradeBusy}
                    onClick={() => void executeTradeSignal(askPromptSignal)}
                    className="flex-1 rounded bg-[#00A88F] px-3 py-2 font-bold text-white hover:bg-[#00917b] disabled:opacity-50"
                  >
                    Place Trade (${effectiveNextStake.toFixed(2)})
                  </button>
                  <button
                    type="button"
                    onClick={() => setAskPromptSignal(null)}
                    className="rounded border border-[#E5E9EF] bg-white px-3 py-2 font-semibold text-[#20242B] dark:border-[#243040] dark:bg-[#151D27] dark:text-white"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}

            {/* Live Deriv Payout Preview */}
            {liveProposal && !drawdownLocked && (
              <div className="mt-3 flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 font-mono text-xs tabular-nums dark:bg-[#0F151D]">
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">
                  Payout: <strong className="text-[#20242B] dark:text-white">${liveProposal.payout.toFixed(2)}</strong>
                </span>
                <span className="text-[#6B7280] dark:text-[#9CA3AF]">
                  Net Win:{' '}
                  <strong className="text-[#00A88F]">
                    {potentialReturn !== null ? `+$${potentialReturn.toFixed(2)}` : '—'}
                  </strong>
                </span>
              </div>
            )}

            {/* Real Account Safety Opt-in */}
            {derivSession.connected && !derivSession.activeIsVirtual && (
              <label className="mt-3 flex items-center gap-2 rounded border border-[#FF444F]/40 bg-[#FF444F]/10 px-3 py-2 text-xs text-[#FF444F]">
                <input
                  type="checkbox"
                  checked={realAccountOptIn}
                  onChange={(e) => setRealAccountOptIn(e.target.checked)}
                  className="h-4 w-4 accent-[#FF444F]"
                />
                <span>Confirm bot trades on REAL balance ({derivSession.activeLoginId})</span>
              </label>
            )}

            {/* Primary Execution Button */}
            <div className="mt-3">
              {!derivSession.connected ? (
                <button
                  type="button"
                  onClick={onOpenConnect}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-[#0866FF] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#0654d4]"
                >
                  <Wallet className="h-4 w-4" />
                  Connect Deriv to Trade
                </button>
              ) : drawdownLocked ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-[#FF444F] bg-[#FF444F]/10 px-3 py-2.5 text-xs text-[#FF444F]">
                  <span className="flex items-center gap-1.5 font-bold">
                    <Lock className="h-4 w-4" />
                    $10.00 Drawdown Stop Active
                  </span>
                  <button
                    type="button"
                    onClick={resetSessionProgress}
                    className="rounded bg-[#FF444F] px-2.5 py-1 font-bold text-white"
                  >
                    Reset Session
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={tradeBusy || !lockedSignal}
                  onClick={() => lockedSignal && void executeTradeSignal(lockedSignal)}
                  className={`flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50 ${
                    derivSession.activeIsVirtual
                      ? 'bg-[#00A88F] hover:bg-[#00917b]'
                      : 'bg-[#FF444F] hover:bg-[#e53843]'
                  }`}
                >
                  <Play className="h-3.5 w-3.5" />
                  {tradeBusy
                    ? 'Placing Trade…'
                    : `Place ${activeContractType === 'DIGITMATCH' ? 'Matches' : 'Differs'} Digit ${activeDigit} · $${effectiveNextStake.toFixed(2)}`}
                </button>
              )}
            </div>

            {statusMessage && (
              <div className="mt-2.5 flex items-start gap-2 rounded bg-[#F5F7FA] px-3 py-2 text-xs text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]">
                {statusMessage.includes('Loss') || statusMessage.includes('Stopped') ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#FFAD3A]" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#00A88F]" />
                )}
                <span>{statusMessage}</span>
              </div>
            )}

            {/* Session Trades Ledger */}
            {sessionTrades.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
                <div className="text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Session Trades
                </div>
                <div className="max-h-44 space-y-1.5 overflow-y-auto">
                  {sessionTrades.slice(0, 8).map((tr) => (
                    <div
                      key={tr.contractId}
                      className="flex items-center justify-between rounded bg-[#F5F7FA] px-3 py-2 text-xs dark:bg-[#0F151D]"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-[#20242B] dark:text-white">
                          {tr.contractType === 'DIGITMATCH' ? 'Match' : 'Differ'} {tr.digit} · {tr.symbol}
                        </div>
                        <div className="font-mono text-[10px] tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                          Stake ${tr.stake.toFixed(2)} · Spot {tr.entrySpot ?? '—'} → {tr.exitSpot ?? '—'}
                        </div>
                      </div>
                      <span
                        className={`font-mono font-bold tabular-nums ${
                          tr.status === 'open'
                            ? 'text-[#0866FF]'
                            : tr.profit >= 0
                            ? 'text-[#00A88F]'
                            : 'text-[#FF4D5A]'
                        }`}
                      >
                        {tr.status === 'open'
                          ? 'LIVE…'
                          : `${tr.profit >= 0 ? '+' : ''}$${tr.profit.toFixed(2)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
