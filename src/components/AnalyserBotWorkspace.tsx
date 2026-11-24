import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Crown,
  Download,
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
import type { BotStrategyConfig } from '../types/deriv';
import type {
  ActiveSymbol,
  DerivSessionState,
  DigitsFullResponse,
  LiveDerivContract,
  LiveTickEvent,
} from '../types/dqi';
import { loadPreloadedStrategies } from '../utils/preloadedAssets';
import { serializeConfigToXml } from '../utils/xmlParser';
import {
  evaluateDigitDistributionStats,
  evaluateLiveDigitSignals,
  mergeUniqueTicks,
  runWalkForwardDigitReplay,
  type RankedSignal,
  type StrategyFilter,
} from '../utils/digitSignalEngine';

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

type BotProfile = 'SMART_BEST' | 'DIFFERS_SCALPER' | 'MATCHES_SCALPER';
type BotMode = 'MANUAL' | 'ASK' | 'AUTO';

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
  { id: 2, label: 'Markov', icon: Layers },
  { id: 3, label: 'Break-Even', icon: Timer },
  { id: 4, label: 'Gate', icon: TrendingUp },
] as const;

const MIN_STAKE_PRESETS = [0.35, 0.5, 1.0];
const BOT_SETTINGS_KEY = 'dqi_match_differ_bot_v3';

function marketNameFor(code: string, symbols: ActiveSymbol[]): string {
  return (
    symbols.find((s) => s.symbol === code)?.display_name ||
    CORE_MARKETS.find((m) => m.code === code)?.label ||
    code
  );
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
    return [selectedSymbol || '1HZ100V'];
  });

  const [botProfile, setBotProfile] = useState<BotProfile>(() =>
    savedCfg.botProfile === 'DIFFERS_SCALPER' || savedCfg.botProfile === 'MATCHES_SCALPER'
      ? savedCfg.botProfile
      : 'SMART_BEST'
  );
  const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>(() =>
    savedCfg.strategyFilter === 'DIGITMATCH' || savedCfg.strategyFilter === 'DIGITDIFF'
      ? savedCfg.strategyFilter
      : 'BEST'
  );
  const [botMode, setBotMode] = useState<BotMode>('MANUAL');
  const [strictEdgeGate, setStrictEdgeGate] = useState<boolean>(() =>
    typeof savedCfg.strictEdgeGate === 'boolean' ? savedCfg.strictEdgeGate : true
  );

  // Stake, 2-win progression & strict TP / SL / $10 Drawdown Protection
  const [minStake, setMinStake] = useState<number>(() =>
    typeof savedCfg.minStake === 'number' && savedCfg.minStake >= 0.35 ? savedCfg.minStake : 0.35
  );
  const [winStepAdd, setWinStepAdd] = useState<number>(() =>
    typeof savedCfg.winStepAdd === 'number' && savedCfg.winStepAdd >= 0 ? savedCfg.winStepAdd : 0.25
  );
  const [maxStakeCap, setMaxStakeCap] = useState<number>(() =>
    typeof savedCfg.maxStakeCap === 'number' && savedCfg.maxStakeCap >= 0.35 ? savedCfg.maxStakeCap : 1.5
  );
  const [takeProfitTarget, setTakeProfitTarget] = useState<number>(() =>
    typeof savedCfg.takeProfitTarget === 'number' && savedCfg.takeProfitTarget >= 0.5
      ? savedCfg.takeProfitTarget
      : 5.0
  );
  const [stopLossLimit, setStopLossLimit] = useState<number>(() =>
    typeof savedCfg.stopLossLimit === 'number' && savedCfg.stopLossLimit >= 0.5
      ? Math.min(10.0, savedCfg.stopLossLimit)
      : 4.0
  );
  const [burstMaxTrades, setBurstMaxTrades] = useState<number>(() =>
    typeof savedCfg.burstMaxTrades === 'number' && savedCfg.burstMaxTrades >= 0
      ? savedCfg.burstMaxTrades
      : 5
  );
  const [maxConsecLossesStop, setMaxConsecLossesStop] = useState<number>(() =>
    typeof savedCfg.maxConsecLossesStop === 'number' && savedCfg.maxConsecLossesStop >= 0
      ? savedCfg.maxConsecLossesStop
      : 1
  );
  const maxDrawdown = 10.0;

  useEffect(() => {
    try {
      window.localStorage.setItem(
        BOT_SETTINGS_KEY,
        JSON.stringify({
          scanMarkets,
          botProfile,
          strategyFilter,
          strictEdgeGate,
          minStake,
          winStepAdd,
          maxStakeCap,
          takeProfitTarget,
          stopLossLimit,
          burstMaxTrades,
          maxConsecLossesStop,
        })
      );
    } catch {
      // ignore storage errors
    }
  }, [
    scanMarkets,
    botProfile,
    strategyFilter,
    strictEdgeGate,
    minStake,
    winStepAdd,
    maxStakeCap,
    takeProfitTarget,
    stopLossLimit,
    burstMaxTrades,
    maxConsecLossesStop,
  ]);

  // Preloaded XML Bot Strategies (DiffersScalper + MatchesScalper)
  const [xmlConfigs, setXmlConfigs] = useState<BotStrategyConfig[]>([]);
  useEffect(() => {
    void loadPreloadedStrategies()
      .then((list) => setXmlConfigs(list))
      .catch(() => undefined);
  }, []);

  // Live 500-tick server/WS analysis state
  const [digitsData, setDigitsData] = useState<DigitsFullResponse | null>(null);
  const [syncingData, setSyncingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // 5-phase scanner state & watchlist signals
  const [scanning, setScanning] = useState(false);
  const [scanPhaseIdx, setScanPhaseIdx] = useState<number>(4);
  const [lastAnalysisTime, setLastAnalysisTime] = useState<string | null>(null);
  const [watchlistSignals, setWatchlistSignals] = useState<RankedSignal[]>([]);
  const [manualPickedDigit, setManualPickedDigit] = useState<{
    symbol: string;
    digit: number;
    contractType: 'DIGITMATCH' | 'DIGITDIFF';
  } | null>(null);
  const [askPromptSignal, setAskPromptSignal] = useState<RankedSignal | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [realAccountOptIn, setRealAccountOptIn] = useState(false);

  // Bot session progress & anti-loss protection
  const [sessionAccountId, setSessionAccountId] = useState<string | null>(null);
  const [sessionStartBalance, setSessionStartBalance] = useState<number | null>(null);
  const [sessionPeakBalance, setSessionPeakBalance] = useState<number | null>(null);
  const [consecutiveWins, setConsecutiveWins] = useState(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [burstTradesCompleted, setBurstTradesCompleted] = useState(0);
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number | null>(null);
  const [cooldownSecLeft, setCooldownSecLeft] = useState<number>(0);
  const [currentStake, setCurrentStake] = useState<number>(minStake);
  const [sessionTrades, setSessionTrades] = useState<BotTradeRecord[]>([]);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const processedContractsRef = useRef<Set<number>>(new Set());

  // Apply user's uploaded XML bot profile presets cleanly
  const selectBotProfile = useCallback(
    (profile: BotProfile) => {
      setBotProfile(profile);
      setManualPickedDigit(null);
      setAskPromptSignal(null);
      if (profile === 'DIFFERS_SCALPER') {
        const xml = xmlConfigs.find((x) => x.id === 'differs-scalper');
        setStrategyFilter('DIGITDIFF');
        const base = xml ? Math.max(0.35, Math.min(xml.initialStake, 1.0)) : 0.5;
        const step = xml ? xml.winStep : 0.25;
        const maxSteps = xml ? xml.maxWinSteps : 3;
        setMinStake(base);
        setWinStepAdd(step);
        setMaxStakeCap(Number((base + step * maxSteps).toFixed(2)));
        setTakeProfitTarget(xml ? xml.profitThreshold : 5.0);
        setStopLossLimit(xml ? Math.min(10, xml.lossThreshold) : 5.0);
        setMaxConsecLossesStop(1);
        setBurstMaxTrades((prev) => (prev === 0 ? 5 : prev));
        setStatusMessage(
          'Loaded DiffersScalper (90% hit odds) + Stop-on-1st-Loss & burst cap.'
        );
      } else if (profile === 'MATCHES_SCALPER') {
        const xml = xmlConfigs.find((x) => x.id === 'matches-scalper');
        setStrategyFilter('DIGITMATCH');
        const base = xml ? Math.max(0.35, xml.initialStake) : 0.5;
        const step = xml ? xml.winStep : 0.25;
        const maxSteps = xml ? xml.maxWinSteps : 2;
        setMinStake(base);
        setWinStepAdd(step);
        setMaxStakeCap(Number((base + step * maxSteps).toFixed(2)));
        setTakeProfitTarget(xml ? xml.profitThreshold : 5.0);
        setStopLossLimit(xml ? Math.min(10, xml.lossThreshold) : 4.0);
        setMaxConsecLossesStop(3);
        setBurstMaxTrades((prev) => (prev === 0 ? 5 : prev));
        setStatusMessage(
          'Loaded MatchesScalper (10% true hit odds). Max 3 consecutive losses protection enabled.'
        );
      } else {
        setStrategyFilter('BEST');
        setMaxConsecLossesStop(1);
        setStatusMessage('Smart Best mode: prioritizes 90% Cold-Digit Differ setups with burst & loss protection.');
      }
    },
    [xmlConfigs]
  );

  // Sync session start/peak balance when Deriv account connects or switches
  useEffect(() => {
    if (!derivSession.connected || derivSession.activeBalance === null) return;
    if (sessionAccountId !== derivSession.activeLoginId) {
      setSessionAccountId(derivSession.activeLoginId);
      setSessionStartBalance(derivSession.activeBalance);
      setSessionPeakBalance(derivSession.activeBalance);
      setConsecutiveWins(0);
      setConsecutiveLosses(0);
      setCooldownUntilMs(null);
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

  // Countdown timer for anti-loss cooldown shield
  useEffect(() => {
    if (!cooldownUntilMs) {
      setCooldownSecLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntilMs - Date.now()) / 1000));
      setCooldownSecLeft(left);
      if (left <= 0) {
        setCooldownUntilMs(null);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntilMs]);

  // Compute live session metrics, Take Profit, Stop Loss & $10 Drawdown Guard
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
  const effectiveStopCap = Math.min(maxDrawdown, stopLossLimit);
  const drawdownRemaining = Math.max(0, Number((effectiveStopCap - drawdownUsed).toFixed(2)));
  const takeProfitHit = sessionRealizedPnl >= takeProfitTarget;
  const drawdownLocked = drawdownUsed >= effectiveStopCap || drawdownRemaining < 0.35;
  const sessionHalted = drawdownLocked || takeProfitHit;

  const effectiveNextStake = useMemo(() => {
    if (sessionHalted) return 0;
    const capped = Math.min(currentStake, maxStakeCap, drawdownRemaining);
    return Math.max(0.35, Number(capped.toFixed(2)));
  }, [currentStake, maxStakeCap, drawdownRemaining, sessionHalted]);

  // Live merged 500-tick stream updated on EVERY single Deriv WebSocket tick
  const liveMergedTicks = useMemo(() => {
    const bufTicks = dqiApi.getBufferedTicks(selectedSymbol).map((t) => ({
      digit: t.lastDigit,
      quote: t.rawQuote,
      epoch: t.epoch,
    }));
    const analyticsTape = (digitsData?.analytics.tape ?? []).map((t) => ({
      digit: t.digit,
      quote: t.quote,
      epoch: t.epoch,
    }));
    const wsTape = liveTapeBuffer.map((t) => ({
      digit: t.lastDigit,
      quote: t.rawQuote,
      epoch: t.epoch,
    }));
    return mergeUniqueTicks([...analyticsTape, ...bufTicks], wsTape, 500);
  }, [selectedSymbol, digitsData, liveTapeBuffer]);

  const distStats = useMemo(() => evaluateDigitDistributionStats(liveMergedTicks), [liveMergedTicks]);

  // Live real-time digit rankings recomputed on EVERY incoming tick!
  const liveComputedSignals = useMemo(() => {
    if (liveMergedTicks.length < 30) return [];
    return evaluateLiveDigitSignals({
      symbol: selectedSymbol,
      symbolLabel: marketNameFor(selectedSymbol, symbols),
      ticks: liveMergedTicks,
      filter: strategyFilter,
      volatilityRegime: digitsData?.volatility.regime || 'NORMAL',
      matchProposal: digitsData?.proposals.match ?? null,
      differProposal: digitsData?.proposals.differ ?? null,
    });
  }, [
    liveMergedTicks,
    selectedSymbol,
    symbols,
    strategyFilter,
    digitsData?.volatility.regime,
    digitsData?.proposals.match,
    digitsData?.proposals.differ,
  ]);

  // Combine multi-market scan results (when scanning >1 market) with live tick-by-tick current market signals
  const rankedSignals = useMemo(() => {
    if (watchlistSignals.length === 0) return liveComputedSignals;
    const otherMarkets = watchlistSignals.filter((s) => s.symbol !== selectedSymbol);
    const combined = [...liveComputedSignals.slice(0, 4), ...otherMarkets];
    combined.sort((a, b) => {
      if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
      return b.score - a.score;
    });
    return combined;
  }, [watchlistSignals, liveComputedSignals, selectedSymbol]);

  const lockedSignal: RankedSignal | null = useMemo(() => {
    if (manualPickedDigit && manualPickedDigit.symbol === selectedSymbol) {
      const exact = liveComputedSignals.find(
        (s) =>
          s.digit === manualPickedDigit.digit &&
          s.contractType === manualPickedDigit.contractType
      );
      if (exact) return exact;
    }
    return rankedSignals[0] ?? null;
  }, [manualPickedDigit, selectedSymbol, liveComputedSignals, rankedSignals]);

  // Zero-lookahead replay over the most recent real Deriv ticks (updates every 5 ticks so UI stays silky smooth)
  const replayBucket = Math.floor(liveMergedTicks.length / 5);
  const replayProof = useMemo(() => {
    const targetType: 'DIGITMATCH' | 'DIGITDIFF' =
      lockedSignal?.contractType ?? (strategyFilter === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF');
    if (liveMergedTicks.length < 130) return null;
    return runWalkForwardDigitReplay({
      symbol: selectedSymbol,
      symbolLabel: marketNameFor(selectedSymbol, symbols),
      ticks: liveMergedTicks,
      contractType: targetType,
      volatilityRegime: digitsData?.volatility.regime || 'NORMAL',
      matchProposal: digitsData?.proposals.match ?? null,
      differProposal: digitsData?.proposals.differ ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    replayBucket,
    selectedSymbol,
    strategyFilter,
    lockedSignal?.contractType,
    digitsData?.volatility.regime,
    digitsData?.proposals.match,
    digitsData?.proposals.differ,
  ]);

  useEffect(() => {
    if (latestTick) {
      setLastAnalysisTime(new Date().toLocaleTimeString());
    }
  }, [latestTick]);

  // Fetch 500-tick baseline + real Deriv Match/Differ proposals when symbol changes
  const syncSelectedSymbolData = useCallback(async () => {
    setSyncingData(true);
    setDataError(null);
    try {
      const res = await dqiApi.analyzeDigits(selectedSymbol, 500, effectiveNextStake || minStake, 1);
      setDigitsData(res);
      setLastAnalysisTime(new Date().toLocaleTimeString());
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Waiting for Deriv live quotes...');
    } finally {
      setSyncingData(false);
    }
  }, [selectedSymbol, effectiveNextStake, minStake]);

  useEffect(() => {
    let cancelled = false;
    void dqiApi
      .analyzeDigits(selectedSymbol, 500, minStake, 1)
      .then((res) => {
        if (!cancelled) {
          setDigitsData(res);
          setDataError(null);
          setLastAnalysisTime((prev) => prev || new Date().toLocaleTimeString());
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
  }, [selectedSymbol, minStake]);

  const [liveProposal, setLiveProposal] = useState<{ askPrice: number; payout: number } | null>(null);
  const activeContractType: 'DIGITMATCH' | 'DIGITDIFF' =
    lockedSignal?.contractType ?? (strategyFilter === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF');
  const activeDigit = lockedSignal?.digit ?? 0;

  useEffect(() => {
    if (sessionHalted) return;
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
  }, [lockedSignal?.symbol, selectedSymbol, activeContractType, activeDigit, effectiveNextStake, minStake, sessionHalted]);

  const liveDigits = useMemo(() => {
    const win = liveMergedTicks.slice(-100);
    const counts = new Array<number>(10).fill(0);
    for (const row of win) counts[row.digit] += 1;
    const total = win.length;
    return {
      total100: total,
      totalAll: liveMergedTicks.length,
      bars: counts.map((c, digit) => ({
        digit,
        count: c,
        pct: total > 0 ? (c / total) * 100 : 0,
      })),
      tape20: liveMergedTicks.slice(-20),
    };
  }, [liveMergedTicks]);

  // Watch liveContracts for settlement -> 2-win stake booster / immediate min-loss reset / loss cooldown
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
      setBurstTradesCompleted((prev) => prev + 1);
      if (live.profit > 0) {
        setConsecutiveLosses(0);
        setConsecutiveWins((prevStreak) => {
          const nextStreak = prevStreak + 1;
          if (nextStreak >= 2 && nextStreak % 2 === 0) {
            setCurrentStake((prevStake) => {
              const boosted = Math.min(maxStakeCap, Number((prevStake + winStepAdd).toFixed(2)));
              setStatusMessage(
                `2 consecutive wins! Stake stepped up to $${boosted.toFixed(2)} (+$${winStepAdd.toFixed(2)}).`
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
        setConsecutiveLosses((prevLosses) => {
          const nextLosses = prevLosses + 1;
          if (maxConsecLossesStop > 0 && nextLosses >= maxConsecLossesStop) {
            setAutoRunning(false);
            setAskPromptSignal(null);
            setCooldownUntilMs(Date.now() + 20_000);
            setStatusMessage(
              `Auto-Stopped after ${nextLosses} loss(es) ($${live.profit.toFixed(2)}). Stake reset to $${minStake.toFixed(2)} to protect your balance.`
            );
          } else {
            const shouldCooldown = tracked.contractType === 'DIGITDIFF' || nextLosses >= 3;
            if (shouldCooldown) {
              setCooldownUntilMs(Date.now() + 20_000);
              setStatusMessage(
                `Loss ($${live.profit.toFixed(2)}). Stake reset to min $${minStake.toFixed(2)} + 20s cooldown active.`
              );
            } else {
              setStatusMessage(
                `Miss #${nextLosses} ($${live.profit.toFixed(2)}). Stake held at minimum $${minStake.toFixed(2)}.`
              );
            }
          }
          return nextLosses;
        });
      }
    }
  }, [liveContracts, sessionTrades, maxStakeCap, winStepAdd, minStake, maxConsecLossesStop]);

  // Execute 5-step Deep Analysis across user's chosen scanMarkets ONLY
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
        const res = await dqiApi.analyzeDigits(sym, 500, effectiveNextStake || minStake, 1);
        setScanPhaseIdx(1);
        await new Promise((r) => window.setTimeout(r, 70));
        setScanPhaseIdx(2);
        await new Promise((r) => window.setTimeout(r, 70));
        setScanPhaseIdx(3);

        const symTicks = mergeUniqueTicks(
          dqiApi.getBufferedTicks(sym).map((t) => ({
            digit: t.lastDigit,
            quote: t.rawQuote,
            epoch: t.epoch,
          })),
          (res.analytics.tape ?? []).map((t) => ({
            digit: t.digit,
            quote: t.quote,
            epoch: t.epoch,
          })),
          500
        );

        const candidates = evaluateLiveDigitSignals({
          symbol: sym,
          symbolLabel: marketNameFor(sym, symbols),
          ticks: symTicks,
          filter: strategyFilter,
          volatilityRegime: res.volatility.regime,
          matchProposal: res.proposals.match,
          differProposal: res.proposals.differ,
        });

        if (candidates.length > 0) {
          allRanked.push(...candidates.slice(0, 3));
        }
        if (sym === selectedSymbol) {
          setDigitsData(res);
        }
      }

      setScanPhaseIdx(4);
      allRanked.sort((a, b) => {
        if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
        return b.score - a.score;
      });
      setWatchlistSignals(allRanked);

      const best = allRanked[0] ?? null;
      if (best) {
        setLastAnalysisTime(new Date().toLocaleTimeString());
        if (best.symbol !== selectedSymbol && best.entryReady) {
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
      if (takeProfitHit) {
        setAutoRunning(false);
        setStatusMessage(`Take Profit target (+$${takeProfitTarget.toFixed(2)}) reached! Profit locked.`);
        return;
      }
      if (drawdownLocked) {
        setAutoRunning(false);
        setStatusMessage(`Stopped: $${effectiveStopCap.toFixed(2)} protection stop reached. Reset session to resume.`);
        return;
      }
      if (!derivSession.activeIsVirtual && !realAccountOptIn) {
        setStatusMessage('Tick the Real Account safety confirmation checkbox before placing a live trade.');
        return;
      }

      const stakeToUse = effectiveNextStake;
      if (stakeToUse < 0.35 || stakeToUse > drawdownRemaining) {
        setAutoRunning(false);
        setStatusMessage('Trade blocked to protect your session stop limit.');
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
      takeProfitHit,
      takeProfitTarget,
      drawdownLocked,
      effectiveStopCap,
      realAccountOptIn,
      effectiveNextStake,
      drawdownRemaining,
      onOpenConnect,
    ]
  );

  const hasOpenBotTrade = useMemo(() => sessionTrades.some((t) => t.status === 'open'), [sessionTrades]);

  // Controlled Auto / Ask Bot Loop — honors burst cap, loss-streak stop, and sample filter
  useEffect(() => {
    if (!autoRunning) return;
    if (botMode === 'MANUAL' || sessionHalted) {
      setAutoRunning(false);
      return;
    }
    if (burstMaxTrades > 0 && burstTradesCompleted >= burstMaxTrades) {
      setAutoRunning(false);
      setAskPromptSignal(null);
      setStatusMessage(
        `Burst cap reached (${burstTradesCompleted}/${burstMaxTrades} trades). Review P&L before starting another burst.`
      );
      return;
    }
    if (cooldownSecLeft > 0) return;
    if (botMode === 'ASK' && askPromptSignal) return;
    if (tradeBusy || hasOpenBotTrade || scanning) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        const best =
          scanMarkets.length <= 1 && liveComputedSignals.length > 0
            ? liveComputedSignals[0]
            : await runTargetedScan();
        if (!best) return;

        if (strictEdgeGate && !best.entryReady) {
          setStatusMessage(
            `Standby (${best.symbolLabel}): ${best.contractType === 'DIGITMATCH' ? 'Match' : 'Differ'} ${best.digit} (${best.score}/100 index) — waiting for all 5 sample filters.`
          );
          return;
        }
        if (!strictEdgeGate && best.score < 58) {
          setStatusMessage(`Standby: sample fit ${best.score}/100 below 58 safety floor.`);
          return;
        }

        if (botMode === 'ASK') {
          setAskPromptSignal(best);
        } else if (botMode === 'AUTO') {
          await executeTradeSignal(best);
        }
      })();
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [
    autoRunning,
    botMode,
    sessionHalted,
    burstMaxTrades,
    burstTradesCompleted,
    cooldownSecLeft,
    askPromptSignal,
    tradeBusy,
    hasOpenBotTrade,
    scanning,
    scanMarkets.length,
    liveComputedSignals,
    strictEdgeGate,
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
    setConsecutiveLosses(0);
    setBurstTradesCompleted(0);
    setCooldownUntilMs(null);
    setCurrentStake(minStake);
    setSessionTrades([]);
    processedContractsRef.current.clear();
    setAutoRunning(false);
    setAskPromptSignal(null);
    setStatusMessage('Session reset. Stake back at minimum and protection counters cleared.');
  };

  // Export user's DiffersScalper or MatchesScalper XML calibrated with the live predicted digit & parameters
  const handleExportCalibratedXml = () => {
    const targetType = lockedSignal?.contractType ?? (strategyFilter === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF');
    const sourceId = targetType === 'DIGITMATCH' ? 'matches-scalper' : 'differs-scalper';
    const baseXml = xmlConfigs.find((x) => x.id === sourceId) || xmlConfigs[0];
    if (!baseXml) {
      setStatusMessage('XML template still loading — please retry in a moment.');
      return;
    }
    const updatedXml = serializeConfigToXml({
      ...baseXml,
      symbol: lockedSignal?.symbol || selectedSymbol,
      purchaseType: targetType,
      prediction: activeDigit,
      initialStake: minStake,
      winStep: winStepAdd,
      profitThreshold: takeProfitTarget,
      lossThreshold: stopLossLimit,
    });
    const blob = new Blob([updatedXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${targetType === 'DIGITMATCH' ? 'MatchesScalper' : 'DiffersScalper'}_${selectedSymbol}_Digit${activeDigit}.xml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatusMessage(
      `Exported ${targetType === 'DIGITMATCH' ? 'MatchesScalper' : 'DiffersScalper'} XML set to ${selectedSymbol} Digit ${activeDigit}.`
    );
  };

  const displayQuote = latestTick?.rawQuote ?? digitsData?.analytics.latestQuote ?? null;
  const displayDigit = latestTick?.lastDigit ?? digitsData?.analytics.latestObservedDigit ?? null;
  const quotePrefix = displayQuote && displayQuote.length > 1 ? displayQuote.slice(0, -1) : '';
  const quoteLastChar = displayQuote ? displayQuote.slice(-1) : '';

  const drawdownPct = Math.min(100, (drawdownUsed / effectiveStopCap) * 100);
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

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        {/* LEFT COLUMN (7 cols): Market & XML Bot Selector -> 5-Step Analysis Engine -> Centered Prediction Hero -> Live Confluence & Replay */}
        <div className="space-y-4 lg:col-span-7">
          {/* 1. MARKET & BOT PROFILE SELECTOR CARD */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-[#0866FF]" />
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  Market &amp; Bot Selector
                </h2>
              </div>

              {/* Bot Profile Toggle (Smart Best / DiffersScalper XML / MatchesScalper XML) */}
              <div className="flex items-center rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-0.5 dark:border-[#243040] dark:bg-[#0F151D]">
                {(
                  [
                    { id: 'SMART_BEST', label: 'Smart Best' },
                    { id: 'DIFFERS_SCALPER', label: 'DiffersScalper' },
                    { id: 'MATCHES_SCALPER', label: 'MatchesScalper' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => selectBotProfile(opt.id)}
                    className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition ${
                      botProfile === opt.id
                        ? opt.id === 'MATCHES_SCALPER'
                          ? 'bg-[#00A88F] text-white'
                          : 'bg-[#0866FF] text-white'
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
                  setManualPickedDigit(null);
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

            {/* Clean Action Buttons */}
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={syncingData || scanning}
                onClick={() => void syncSelectedSymbolData()}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-4 py-2 text-xs font-semibold text-[#20242B] hover:border-[#0866FF] disabled:opacity-50 dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncingData ? 'animate-spin text-[#0866FF]' : ''}`} />
                {syncingData ? 'Syncing 500t…' : 'Sync 500 Ticks'}
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

              <button
                type="button"
                onClick={handleExportCalibratedXml}
                className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2 text-xs font-semibold text-[#20242B] hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                title="Download DiffersScalper or MatchesScalper XML updated with the live predicted digit"
              >
                <Download className="h-3.5 w-3.5 text-[#0866FF]" />
                Export Live .xml
              </button>
            </div>

            {/* User-Chosen Bot Scan Watchlist */}
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

          {/* 2. 5-STEP LIVE DATA ENGINE STRIP */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#0866FF]" />
                <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                  Real-Time Digit Engine ({liveMergedTicks.length} live ticks)
                </h2>
              </div>
              <span
                className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                  lockedSignal?.entryReady
                    ? 'bg-[#00A88F]/15 text-[#00A88F]'
                    : lockedSignal?.gateStatus === 'WATCH'
                    ? 'bg-[#FFAD3A]/15 text-[#FFAD3A]'
                    : 'bg-[#F5F7FA] text-[#6B7280] dark:bg-[#0F151D] dark:text-[#9CA3AF]'
                }`}
              >
                {scanning
                  ? `Phase ${scanPhaseIdx + 1}/5`
                  : lockedSignal?.entryReady
                  ? 'ENTRY READY'
                  : lockedSignal?.gateStatus === 'WATCH'
                  ? 'WATCHING'
                  : 'WAIT — NO EDGE'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-5 gap-2">
              {ENGINE_STEPS.map((step) => {
                const Icon = step.icon;
                const checkRow = lockedSignal?.checks[step.id];
                const isDone = !scanning && Boolean(lockedSignal);
                const isCurrent = scanning && scanPhaseIdx === step.id;
                const passedCheck = isDone && checkRow ? checkRow.passed : isDone;
                return (
                  <div
                    key={step.id}
                    title={checkRow ? `${checkRow.label}: ${checkRow.detail}` : step.label}
                    className={`flex flex-col items-center justify-center rounded-md border px-2 py-2.5 text-center transition ${
                      isCurrent
                        ? 'border-[#0866FF] bg-[#0866FF] text-white'
                        : passedCheck
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

            {/* 5-Check Statistical Gate Summary */}
            {lockedSignal && (
              <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {lockedSignal.checks.map((chk) => (
                  <div
                    key={chk.label}
                    className="flex items-center justify-between rounded bg-[#F5F7FA] px-2.5 py-1.5 text-[11px] dark:bg-[#0F151D]"
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          chk.passed ? 'bg-[#00A88F]' : 'bg-[#FFAD3A]'
                        }`}
                      />
                      {chk.label}
                    </span>
                    <span className="font-mono tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                      {chk.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 text-xs font-medium text-[#20242B] dark:text-[#F3F4F6]">
              <CheckCircle2
                className={`h-4 w-4 shrink-0 ${
                  lockedSignal?.entryReady
                    ? 'text-[#00A88F]'
                    : scanning
                    ? 'text-[#0866FF]'
                    : 'text-[#FFAD3A]'
                }`}
              />
              <span>
                {scanning
                  ? `Scanning ${scanMarkets.join(', ')} — Step ${scanPhaseIdx + 1} of 5…`
                  : lockedSignal
                  ? lockedSignal.reason
                  : 'Waiting for 30+ live Deriv ticks to evaluate Matches/Differs edge…'}
              </span>
            </div>
          </section>

          {/* 3. CENTERED PREDICTION HERO CARD */}
          <section className="rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="rounded-lg border border-[#E5E9EF] bg-[#F5F7FA] px-5 py-6 text-center dark:border-[#243040] dark:bg-[#0F151D]">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Crown
                  className={`h-6 w-6 ${
                    activeContractType === 'DIGITMATCH' ? 'text-[#FFAD3A]' : 'text-[#0866FF]'
                  }`}
                />
                <span
                  className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold ${
                    lockedSignal?.entryReady
                      ? activeContractType === 'DIGITDIFF'
                        ? 'bg-[#00A88F] text-white'
                        : 'bg-[#FFAD3A] text-[#101820]'
                      : 'bg-[#E5E9EF] text-[#20242B] dark:bg-[#243040] dark:text-[#F3F4F6]'
                  }`}
                >
                  {lockedSignal?.entryReady
                    ? activeContractType === 'DIGITDIFF'
                      ? 'FILTER READY · COLD DIFFER (90% ODDS)'
                      : 'HOT CLUSTER · MATCH (10% ODDS)'
                    : 'WAIT — NO SAMPLE CLUSTER'}
                </span>
              </div>

              <div className="mt-2 text-sm font-bold text-[#20242B] dark:text-white">
                {activeContractType === 'DIGITMATCH' ? 'Digit Matches' : 'Digit Differs'} Target ·{' '}
                <span className="font-mono text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                  True Base Odds: {lockedSignal ? `${lockedSignal.trueWinProbPct.toFixed(0)}%` : '—'}
                </span>
              </div>

              <div className="mt-3 font-mono text-6xl font-bold leading-none tabular-nums text-[#20242B] dark:text-white">
                {lockedSignal ? lockedSignal.digit : '—'}
              </div>

              <div className="mx-auto mt-4 max-w-sm">
                <div className="h-2.5 overflow-hidden rounded-full bg-[#E5E9EF] dark:bg-[#243040]">
                  <div
                    className={`h-full transition-all duration-300 ${
                      lockedSignal?.entryReady
                        ? activeContractType === 'DIGITDIFF'
                          ? 'bg-[#00A88F]'
                          : 'bg-[#FFAD3A]'
                        : confidencePct >= 65
                        ? 'bg-[#0866FF]'
                        : 'bg-[#FFAD3A]'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(4, confidencePct))}%` }}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-center gap-3 font-mono text-xs font-bold tabular-nums text-[#20242B] dark:text-white">
                <span>Sample Fit: {lockedSignal ? `${confidencePct}/100` : '—'}</span>
                <span>·</span>
                <span>
                  Sample vs BE:{' '}
                  <span
                    className={
                      lockedSignal && lockedSignal.edgePct >= 1.0
                        ? 'text-[#00A88F]'
                        : 'text-[#FFAD3A]'
                    }
                  >
                    {lockedSignal
                      ? `${lockedSignal.edgePct >= 0 ? '+' : ''}${lockedSignal.edgePct.toFixed(1)}%`
                      : '—'}
                  </span>
                </span>
              </div>

              <div className="mt-1.5 font-mono text-[11px] tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                {distStats.sampleCount}t χ²={distStats.chiSquare.toFixed(1)} (
                {distStats.regimeLabel === 'SKEWED_SAMPLE'
                  ? 'Recent Sample Skewed'
                  : 'Fair Random Stream — no guaranteed streak'}
                )
              </div>

              <div className="mt-1 font-mono text-[11px] tabular-nums text-[#6B7280] dark:text-[#9CA3AF]">
                Updated: {lastAnalysisTime || 'Streaming…'}
                {lockedSignal ? ` · ${lockedSignal.symbolLabel} (${lockedSignal.sampleCount} ticks)` : ''}
              </div>

              {/* Zero-Lookahead 120-Tick Real Replay Verification */}
              {replayProof && (
                <div className="mx-auto mt-3 max-w-md rounded border border-[#E5E9EF] bg-white px-3 py-2 text-[11px] dark:border-[#243040] dark:bg-[#151D27]">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums">
                    <span className="font-sans font-semibold text-[#6B7280] dark:text-[#9CA3AF]">
                      120-Tick Backtest Proof:
                    </span>
                    <span className="text-[#20242B] dark:text-white">
                      {replayProof.signalsTriggered > 0
                        ? `${replayProof.wins}W/${replayProof.losses}L (${replayProof.winRatePct}%) · Max Streak ${replayProof.maxLossStreak}L`
                        : '0 gated entries (filter stayed flat)'}
                    </span>
                    {replayProof.signalsTriggered > 0 && (
                      <strong
                        className={
                          replayProof.netPnlPerDollar >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                        }
                      >
                        {replayProof.netPnlPerDollar >= 0 ? '+' : ''}$
                        {replayProof.netPnlPerDollar.toFixed(2)} / $1
                      </strong>
                    )}
                  </div>
                </div>
              )}

              {/* Quick Top-3 Signal Switcher */}
              {rankedSignals.length > 1 && !scanning && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
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
                          setManualPickedDigit({
                            symbol: cand.symbol,
                            digit: cand.digit,
                            contractType: cand.contractType,
                          });
                          if (cand.symbol !== selectedSymbol) onSelectSymbol(cand.symbol);
                        }}
                        className={`rounded px-2.5 py-1 font-mono text-[11px] font-semibold tabular-nums transition ${
                          isPicked
                            ? 'bg-[#0866FF] text-white'
                            : 'border border-[#E5E9EF] bg-white text-[#20242B] hover:border-[#0866FF] dark:border-[#243040] dark:bg-[#151D27] dark:text-[#F3F4F6]'
                        }`}
                      >
                        {cand.contractType === 'DIGITMATCH' ? 'MATCH' : 'DIFF'} {cand.digit} ({cand.score}%)
                        {cand.entryReady ? ' ✓' : ''}
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
                    {marketNameFor(selectedSymbol, symbols)} · Live Tick (100t window / {liveDigits.totalAll}t total)
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
                    <div className="font-sans text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Regime</div>
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
                        setManualPickedDigit({
                          symbol: selectedSymbol,
                          digit: bar.digit,
                          contractType: lockedSignal?.contractType || modeType,
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

            {/* 4. CURRENT MARKET STATS FOOTER LINE */}
            <div className="mt-4 border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
              <div className="flex items-center gap-1.5 text-xs font-bold text-[#0866FF]">
                <BarChart2 className="h-3.5 w-3.5" />
                <span>Current Market Stats</span>
              </div>
              <div className="mt-1 font-mono text-xs tabular-nums text-[#20242B] dark:text-[#F3F4F6]">
                Target Digit: <strong>{lockedSignal ? lockedSignal.digit : '—'}</strong> | True Odds:{' '}
                <strong>{lockedSignal ? `${lockedSignal.trueWinProbPct}%` : '—'}</strong> | Sample Fit:{' '}
                <strong>{lockedSignal ? `${confidencePct}/100` : '—'}</strong> | Latest Tick:{' '}
                <strong>{displayDigit !== null ? displayDigit : '—'}</strong>
              </div>
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN (5 cols): Account Progress + Protection Guard + Controlled Match/Differ Bot */}
        <div className="space-y-4 lg:col-span-5">
          {/* Account Progress & Strict Loss/Profit Guard */}
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

            {/* Drawdown & Take Profit Safety Meter */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 font-semibold text-[#20242B] dark:text-[#F3F4F6]">
                  <ShieldCheck className="h-3.5 w-3.5 text-[#00A88F]" />
                  Loss Guard (${effectiveStopCap.toFixed(2)} Max Stop)
                </span>
                <span className="font-mono text-xs font-bold tabular-nums text-[#20242B] dark:text-white">
                  ${drawdownUsed.toFixed(2)} / ${effectiveStopCap.toFixed(2)}
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
                  TP Target: +${takeProfitTarget.toFixed(2)} · Start:{' '}
                  {sessionStartBalance !== null ? `$${sessionStartBalance.toFixed(2)}` : '—'}
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

            {/* Bot Execution Mode Switch */}
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
                  disabled={sessionHalted}
                  onClick={() => {
                    if (autoRunning) {
                      setAutoRunning(false);
                    } else {
                      if (burstMaxTrades > 0 && burstTradesCompleted >= burstMaxTrades) {
                        setBurstTradesCompleted(0);
                      }
                      setConsecutiveLosses(0);
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
                  {autoRunning ? 'Stop' : 'Start Burst'}
                </button>
              )}
            </div>

            {/* Anti-Runaway Burst Cap & Stop on Loss Streak */}
            <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Max Trades / Burst ({burstTradesCompleted}/{burstMaxTrades || '∞'})
                </label>
                <select
                  value={burstMaxTrades}
                  onChange={(e) => setBurstMaxTrades(Number(e.target.value))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                >
                  <option value={3}>3 trades (Safe)</option>
                  <option value={5}>5 trades (Recommended)</option>
                  <option value={10}>10 trades</option>
                  <option value={0}>No burst cap</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Auto-Stop After Losses
                </label>
                <select
                  value={maxConsecLossesStop}
                  onChange={(e) => setMaxConsecLossesStop(Number(e.target.value))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                >
                  <option value={1}>1 Loss (Best for Differs)</option>
                  <option value={2}>2 Losses in a row</option>
                  <option value={3}>3 Losses (Matches cap)</option>
                  <option value={0}>Off (Use $ Stop only)</option>
                </select>
              </div>
            </div>

            {/* Strict Edge Gate Toggle (Prevents Blind Every-Tick Trading) */}
            <label className="mt-3 flex cursor-pointer items-center justify-between rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2 text-xs dark:border-[#243040] dark:bg-[#0F151D]">
              <div>
                <div className="font-semibold text-[#20242B] dark:text-white">
                  Strict Edge Gate (Wait on Weak Data)
                </div>
                <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                  Only auto-enters when all 5 live checks beat break-even
                </div>
              </div>
              <input
                type="checkbox"
                checked={strictEdgeGate}
                onChange={(e) => setStrictEdgeGate(e.target.checked)}
                className="h-4 w-4 accent-[#00A88F]"
              />
            </label>

            {/* Stake & Protection Inputs */}
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

            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Take Profit ($)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={0.5}
                  max={100}
                  value={takeProfitTarget}
                  onChange={(e) => setTakeProfitTarget(Math.max(0.5, Number(e.target.value)))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#6B7280] dark:text-[#9CA3AF]">
                  Stop Loss ($ · max $10)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={0.5}
                  max={10}
                  value={stopLossLimit}
                  onChange={(e) => setStopLossLimit(Math.min(10, Math.max(0.5, Number(e.target.value))))}
                  className="mt-1 w-full rounded border border-[#E5E9EF] bg-[#F5F7FA] px-2 py-1 font-mono text-xs tabular-nums text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                />
              </div>
            </div>

            <div className="mt-2 text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
              Win 2x in a row → +${winStepAdd.toFixed(2)} · Loss → resets to ${minStake.toFixed(2)} + protective cooldown.
            </div>

            {cooldownSecLeft > 0 && (
              <div className="mt-3 flex items-center justify-between rounded-md border border-[#FFAD3A]/50 bg-[#FFAD3A]/10 px-3 py-2 text-xs text-[#B45309] dark:text-[#FFAD3A]">
                <span className="font-semibold">
                  Protective Cooldown Active ({cooldownSecLeft}s)
                </span>
                <button
                  type="button"
                  onClick={() => setCooldownUntilMs(null)}
                  className="font-bold underline"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Ask-Me Confirmation Banner */}
            {askPromptSignal && !sessionHalted && (
              <div className="mt-3 rounded-md border border-[#0866FF] bg-[#0866FF]/10 p-3 text-xs">
                <div className="font-bold text-[#20242B] dark:text-white">
                  Confirmed Signal: {askPromptSignal.contractType === 'DIGITMATCH' ? 'Matches' : 'Differs'} Digit{' '}
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
            {liveProposal && !sessionHalted && (
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
              ) : takeProfitHit ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-[#00A88F] bg-[#00A88F]/10 px-3 py-2.5 text-xs text-[#00A88F]">
                  <span className="flex items-center gap-1.5 font-bold">
                    <CheckCircle2 className="h-4 w-4" />
                    Take Profit (+${takeProfitTarget.toFixed(2)}) Locked
                  </span>
                  <button
                    type="button"
                    onClick={resetSessionProgress}
                    className="rounded bg-[#00A88F] px-2.5 py-1 font-bold text-white"
                  >
                    New Session
                  </button>
                </div>
              ) : drawdownLocked ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-[#FF444F] bg-[#FF444F]/10 px-3 py-2.5 text-xs text-[#FF444F]">
                  <span className="flex items-center gap-1.5 font-bold">
                    <Lock className="h-4 w-4" />
                    ${effectiveStopCap.toFixed(2)} Protection Stop Active
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
                      ? lockedSignal?.entryReady
                        ? 'bg-[#00A88F] hover:bg-[#00917b]'
                        : 'bg-[#0866FF] hover:bg-[#0654d4]'
                      : 'bg-[#FF444F] hover:bg-[#e53843]'
                  }`}
                >
                  <Play className="h-3.5 w-3.5" />
                  {tradeBusy
                    ? 'Placing Trade…'
                    : lockedSignal?.entryReady
                    ? `Place ${activeContractType === 'DIGITMATCH' ? 'Matches' : 'Differs'} Digit ${activeDigit} · $${effectiveNextStake.toFixed(2)}`
                    : `Manual Entry (No Edge Yet): ${activeContractType === 'DIGITMATCH' ? 'Match' : 'Differ'} ${activeDigit} · $${effectiveNextStake.toFixed(2)}`}
                </button>
              )}
            </div>

            {statusMessage && (
              <div className="mt-2.5 flex items-start gap-2 rounded bg-[#F5F7FA] px-3 py-2 text-xs text-[#20242B] dark:bg-[#0F151D] dark:text-[#F3F4F6]">
                {statusMessage.includes('Loss') ||
                statusMessage.includes('Stopped') ||
                statusMessage.includes('Miss') ||
                statusMessage.includes('Standby') ? (
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
