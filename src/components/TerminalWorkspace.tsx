import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CandlestickChart,
  Clock,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type {
  ActiveSymbol,
  CandleBar,
  ContractSupport,
  LiveTickEvent,
  PaperAccount,
  PaperPosition,
  QuantAnalysis,
} from '../types/dqi';

interface TerminalWorkspaceProps {
  symbols: ActiveSymbol[];
  symbolsError: string | null;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  latestTick: LiveTickEvent | null;
  feedHealth: { state: string; isStale: boolean; ageSeconds: number | null };
  onOpenDigits: () => void;
  onRefreshSymbols: () => void;
}

const TF_OPTIONS: Array<{ label: string; granularity: number }> = [
  { label: 'M1', granularity: 60 },
  { label: 'M5', granularity: 300 },
  { label: 'M15', granularity: 900 },
  { label: 'M30', granularity: 1800 },
  { label: 'H1', granularity: 3600 },
  { label: 'H4', granularity: 14400 },
  { label: 'D1', granularity: 86400 },
];

export const TerminalWorkspace: React.FC<TerminalWorkspaceProps> = ({
  symbols,
  symbolsError,
  selectedSymbol,
  onSelectSymbol,
  latestTick,
  feedHealth,
  onOpenDigits,
  onRefreshSymbols,
}) => {
  const [search, setSearch] = useState('');
  const [marketFilter, setMarketFilter] = useState('ALL');
  const [timeframe, setTimeframe] = useState('M5');
  const [chartMode, setChartMode] = useState<'candles' | 'line'>('candles');
  const [candles, setCandles] = useState<CandleBar[]>([]);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const [contracts, setContracts] = useState<ContractSupport | null>(null);
  const [quant, setQuant] = useState<QuantAnalysis | null>(null);

  // Trade ticket state (Paper virtual account vs Real locked notice)
  const [tradeEnv, setTradeEnv] = useState<'PAPER' | 'LIVE'>('PAPER');
  const [contractType, setContractType] = useState('CALL');
  const [stake, setStake] = useState('10');
  const [durationSec, setDurationSec] = useState('15');
  const [barrier, setBarrier] = useState('5');
  const [proposal, setProposal] = useState<{
    askPrice: number;
    payout: number;
    breakEvenProbPct: number | null;
    fetchedAt: string;
  } | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);

  const [paperAccount, setPaperAccount] = useState<PaperAccount | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);
  const [tradeBusy, setTradeBusy] = useState(false);

  const activeSymObj = useMemo(
    () => symbols.find((s) => s.symbol === selectedSymbol),
    [symbols, selectedSymbol]
  );

  const marketCategories = useMemo(() => {
    const set = new Set<string>();
    symbols.forEach((s) => set.add(s.market_display_name));
    return ['ALL', ...Array.from(set).sort()];
  }, [symbols]);

  const filteredSymbols = useMemo(() => {
    const q = search.trim().toLowerCase();
    return symbols
      .filter((s) => {
        if (marketFilter !== 'ALL' && s.market_display_name !== marketFilter) return false;
        if (!q) return true;
        return (
          s.symbol.toLowerCase().includes(q) ||
          s.display_name.toLowerCase().includes(q) ||
          s.market_display_name.toLowerCase().includes(q)
        );
      })
      .slice(0, 80);
  }, [symbols, marketFilter, search]);

  async function loadChartAndContext() {
    const tf = TF_OPTIONS.find((t) => t.label === timeframe) || TF_OPTIONS[1];
    setCandlesLoading(true);
    setCandlesError(null);
    try {
      const [cRes, ctRes] = await Promise.all([
        dqiApi.getCandles(selectedSymbol, tf.granularity, 90),
        dqiApi.getContractsFor(selectedSymbol).catch(() => null),
      ]);
      setCandles(cRes.candles || []);
      if (ctRes) setContracts(ctRes);
      if ((cRes.candles || []).length >= 35) {
        dqiApi.analyzeQuant(selectedSymbol, timeframe, 120).then(setQuant).catch(() => setQuant(null));
      } else {
        setQuant(null);
      }
    } catch (err) {
      setCandlesError(err instanceof Error ? err.message : 'Unable to load chart candles');
    } finally {
      setCandlesLoading(false);
    }
  }

  async function loadPaperLedger() {
    try {
      const [acc, pos] = await Promise.all([dqiApi.getPaperAccount(), dqiApi.getPaperPositions()]);
      setPaperAccount(acc);
      setPositions(pos.positions || []);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    loadChartAndContext();
    setProposal(null);
  }, [selectedSymbol, timeframe]);

  useEffect(() => {
    loadPaperLedger();
    const timer = setInterval(loadPaperLedger, 5000);
    return () => clearInterval(timer);
  }, []);

  // Update the last candle live when ticks arrive
  const liveCandles = useMemo(() => {
    if (!candles.length) return [];
    if (!latestTick || latestTick.symbol !== selectedSymbol) return candles;
    const copy = [...candles];
    const last = { ...copy[copy.length - 1] };
    last.close = latestTick.quote;
    last.high = Math.max(last.high, latestTick.quote);
    last.low = Math.min(last.low, latestTick.quote);
    copy[copy.length - 1] = last;
    return copy;
  }, [candles, latestTick, selectedSymbol]);

  const priceStats = useMemo(() => {
    if (!liveCandles.length) return null;
    const first = liveCandles[0];
    const last = liveCandles[liveCandles.length - 1];
    const min = Math.min(...liveCandles.map((c) => c.low));
    const max = Math.max(...liveCandles.map((c) => c.high));
    const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0;
    return { min, max, lastClose: last.close, changePct };
  }, [liveCandles]);

  async function handleFetchQuote() {
    setProposalBusy(true);
    setTradeMsg(null);
    try {
      const isDigit = contractType.startsWith('DIGIT');
      const useBarrier = contractType === 'DIGITMATCH' || contractType === 'DIGITDIFF' || contractType === 'DIGITOVER' || contractType === 'DIGITUNDER';
      const p = await dqiApi.getProposal({
        symbol: selectedSymbol,
        contractType,
        amount: Math.max(0.35, Number(stake) || 1),
        duration: isDigit ? 1 : Math.max(15, Number(durationSec) || 15),
        durationUnit: isDigit ? 't' : 's',
        barrier: useBarrier ? barrier : undefined,
      });
      setProposal({
        askPrice: p.askPrice,
        payout: p.payout,
        breakEvenProbPct: p.breakEvenProbPct,
        fetchedAt: p.fetchedAt,
      });
    } catch (err) {
      setTradeMsg(err instanceof Error ? err.message : 'Live proposal unavailable');
    } finally {
      setProposalBusy(false);
    }
  }

  async function handleOpenPaperTrade() {
    setTradeBusy(true);
    setTradeMsg(null);
    try {
      const payoutMult =
        proposal && proposal.askPrice > 0
          ? Number(((proposal.payout - proposal.askPrice) / proposal.askPrice).toFixed(4))
          : contractType === 'DIGITMATCH'
            ? 8.0
            : contractType === 'DIGITDIFF'
              ? 0.1
              : 0.85;
      const isDigit = contractType.startsWith('DIGIT');
      const expiry = isDigit ? 3 : Math.max(5, Number(durationSec) || 15);
      await dqiApi.openPaperTrade({
        symbol: selectedSymbol,
        timeframe,
        contractType,
        barrier:
          contractType === 'DIGITMATCH' ||
          contractType === 'DIGITDIFF' ||
          contractType === 'DIGITOVER' ||
          contractType === 'DIGITUNDER'
            ? barrier
            : undefined,
        direction: contractType === 'PUT' ? 'SELL' : 'BUY',
        stake: Number(stake) || 10,
        expiry_seconds: expiry,
        payout_multiplier: Math.min(10, Math.max(0.05, payoutMult)),
      });
      setTradeMsg('Paper position opened on live Deriv price.');
      await loadPaperLedger();
    } catch (err) {
      setTradeMsg(err instanceof Error ? err.message : 'Unable to open paper trade');
    } finally {
      setTradeBusy(false);
    }
  }

  async function handleSettle(id: number) {
    setTradeBusy(true);
    try {
      await dqiApi.settlePaperPosition(id);
      await loadPaperLedger();
    } catch (err) {
      setTradeMsg(err instanceof Error ? err.message : 'Settlement error');
    } finally {
      setTradeBusy(false);
    }
  }

  const hoverCandle = hoverIdx !== null && liveCandles[hoverIdx] ? liveCandles[hoverIdx] : null;
  const pipDecimals = activeSymObj?.pip_size ?? latestTick?.pipSize ?? 2;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
      {/* LEFT WATCHLIST */}
      <aside className="lg:col-span-3 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E5E9EF] dark:border-[#2A2D30] flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#20242B] dark:text-[#F2F3F4]">Markets</h2>
            <p className="text-xs text-[#6B7280] dark:text-[#9CA3AF]">
              {symbols.length > 0 ? `${symbols.length} active Deriv symbols` : 'Loading symbols'}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefreshSymbols}
            title="Refresh Deriv symbols"
            className="p-2 rounded-md text-[#6B7280] hover:text-[#20242B] dark:hover:text-white hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-2 border-b border-[#E5E9EF] dark:border-[#2A2D30]">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#6B7280] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol (e.g. R_100, EURUSD)"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-[#F2F3F4] focus:outline-none focus:border-[#0866FF]"
            />
          </div>
          <select
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-[#F2F3F4]"
          >
            {marketCategories.map((cat) => (
              <option key={cat} value={cat}>
                {cat === 'ALL' ? 'All Asset Classes' : cat}
              </option>
            ))}
          </select>
        </div>

        <div className="max-h-[540px] overflow-y-auto divide-y divide-[#E5E9EF] dark:divide-[#2A2D30]">
          {symbolsError && (
            <div className="p-4 text-xs text-[#FF4D5A]">
              {symbolsError}
            </div>
          )}
          {!symbolsError && filteredSymbols.length === 0 && (
            <div className="p-6 text-center text-xs text-[#6B7280]">No matching symbols found.</div>
          )}
          {filteredSymbols.map((s) => {
            const active = s.symbol === selectedSymbol;
            return (
              <button
                key={s.symbol}
                type="button"
                onClick={() => onSelectSymbol(s.symbol)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors ${
                  active
                    ? 'bg-[#0866FF]/10 dark:bg-[#0866FF]/20 text-[#0866FF] dark:text-[#08B9E6]'
                    : 'hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20]'
                }`}
              >
                <div className="min-w-0 pr-2">
                  <div className="text-xs font-semibold truncate text-[#20242B] dark:text-[#F2F3F4]">
                    {s.display_name}
                  </div>
                  <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF] truncate">
                    {s.symbol} · {s.market_display_name}
                  </div>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-[#6B7280] shrink-0">
                  {s.exchange_is_open ? 'Open' : 'Closed'}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* CENTER CHART & INDICATORS */}
      <section className="lg:col-span-6 space-y-4">
        <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4">
          {/* Symbol Quote Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-[#E5E9EF] dark:border-[#2A2D30]">
            <div>
              <div className="flex items-center gap-2 text-xs text-[#6B7280] dark:text-[#9CA3AF]">
                <span>{activeSymObj?.market_display_name || 'Deriv Market'}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{selectedSymbol}</span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    feedHealth.state === 'LIVE' && !feedHealth.isStale
                      ? 'text-[#00A88F] font-semibold'
                      : 'text-[#FF4D5A] font-semibold'
                  }
                >
                  {feedHealth.isStale ? 'STALE' : feedHealth.state}
                </span>
              </div>
              <h1 className="text-xl font-bold text-[#20242B] dark:text-white mt-0.5">
                {activeSymObj?.display_name || selectedSymbol}
              </h1>
            </div>

            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Current Quote</div>
                <div className="text-2xl font-bold font-mono tabular-nums text-[#20242B] dark:text-white">
                  {latestTick && latestTick.symbol === selectedSymbol
                    ? latestTick.rawQuote
                    : priceStats
                      ? priceStats.lastClose.toFixed(pipDecimals)
                      : '—'}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">Observed Last Digit</div>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-2xl font-bold font-mono tabular-nums text-[#FF444F]">
                    {latestTick && latestTick.symbol === selectedSymbol ? latestTick.lastDigit : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={onOpenDigits}
                    className="px-2.5 py-1 text-xs font-medium rounded bg-[#101820] text-white hover:bg-[#20242B] transition-colors whitespace-nowrap"
                  >
                    Digits Studio
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Chart Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-1 bg-[#F5F7FA] dark:bg-[#1D1F20] p-1 rounded-md">
              {TF_OPTIONS.map((tf) => (
                <button
                  key={tf.label}
                  type="button"
                  onClick={() => setTimeframe(tf.label)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    timeframe === tf.label
                      ? 'bg-[#0866FF] text-white'
                      : 'text-[#6B7280] hover:text-[#20242B] dark:hover:text-white'
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-[#F5F7FA] dark:bg-[#1D1F20] p-1 rounded-md">
                <button
                  type="button"
                  onClick={() => setChartMode('candles')}
                  className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1 ${
                    chartMode === 'candles'
                      ? 'bg-white dark:bg-[#151717] text-[#20242B] dark:text-white shadow-xs'
                      : 'text-[#6B7280]'
                  }`}
                >
                  <CandlestickChart className="w-3.5 h-3.5" /> Candles
                </button>
                <button
                  type="button"
                  onClick={() => setChartMode('line')}
                  className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1 ${
                    chartMode === 'line'
                      ? 'bg-white dark:bg-[#151717] text-[#20242B] dark:text-white shadow-xs'
                      : 'text-[#6B7280]'
                  }`}
                >
                  <TrendingUp className="w-3.5 h-3.5" /> Line
                </button>
              </div>
              <button
                type="button"
                onClick={loadChartAndContext}
                className="p-1.5 rounded-md border border-[#E5E9EF] dark:border-[#2A2D30] text-[#6B7280] hover:text-[#20242B] dark:hover:text-white"
                title="Reload candles"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${candlesLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* OHLC Hover Strip */}
          <div className="flex flex-wrap items-center justify-between text-[11px] font-mono tabular-nums text-[#6B7280] pb-2 min-h-[22px]">
            {hoverCandle ? (
              <span>
                {new Date(hoverCandle.epoch * 1000).toLocaleString()} · O {hoverCandle.open.toFixed(pipDecimals)} · H{' '}
                {hoverCandle.high.toFixed(pipDecimals)} · L {hoverCandle.low.toFixed(pipDecimals)} · C{' '}
                {hoverCandle.close.toFixed(pipDecimals)}
              </span>
            ) : (
              <span>
                Hover chart for OHLC candle values · {liveCandles.length} real Deriv {timeframe} bars
              </span>
            )}
            {priceStats && (
              <span className={priceStats.changePct >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'}>
                {priceStats.changePct >= 0 ? '+' : ''}
                {priceStats.changePct.toFixed(3)}%
              </span>
            )}
          </div>

          {/* SVG Chart Viewport */}
          <div className="relative h-[340px] w-full bg-[#F5F7FA] dark:bg-[#0E0E0E] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-md overflow-hidden">
            {candlesError ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                <p className="text-sm font-medium text-[#FF4D5A]">{candlesError}</p>
                <button
                  type="button"
                  onClick={loadChartAndContext}
                  className="mt-3 px-4 py-2 text-xs font-medium rounded bg-[#FF444F] text-white"
                >
                  Retry Connection
                </button>
              </div>
            ) : liveCandles.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#6B7280]">
                {candlesLoading ? 'Loading Deriv historical candles…' : 'No candle history available'}
              </div>
            ) : (
              <ChartSvg
                candles={liveCandles}
                mode={chartMode}
                pipDecimals={pipDecimals}
                hoverIdx={hoverIdx}
                onHover={setHoverIdx}
              />
            )}
          </div>
        </div>

        {/* Simple Quant Summary Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Signal"
            value={quant ? quant.direction : '—'}
            tone={quant?.direction === 'BUY' ? 'buy' : quant?.direction === 'SELL' ? 'sell' : 'neutral'}
            sub={quant ? `${(quant.calibrated_confidence * 100).toFixed(0)}% raw score` : 'Run chart'}
          />
          <StatTile label="Regime" value={quant ? quant.regime.replaceAll('_', ' ') : '—'} sub={`TF ${timeframe}`} />
          <StatTile
            label="RSI (14)"
            value={quant?.indicators.rsi14 !== null && quant?.indicators.rsi14 !== undefined ? quant.indicators.rsi14.toFixed(1) : '—'}
            sub="Momentum"
          />
          <StatTile
            label="Support / Res"
            value={
              quant?.indicators.support && quant?.indicators.resistance
                ? `${quant.indicators.support.toFixed(pipDecimals)}`
                : '—'
            }
            sub={quant?.indicators.resistance ? `Res ${quant.indicators.resistance.toFixed(pipDecimals)}` : 'Donchian 20'}
          />
        </div>
      </section>

      {/* RIGHT TRADE TICKET & PAPER POSITIONS */}
      <aside className="lg:col-span-3 space-y-4">
        <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-3">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">Order Ticket</h2>
              <p className="text-xs text-[#6B7280]">Virtual simulation or gated live proposal</p>
            </div>
            <div className="flex rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTradeEnv('PAPER')}
                className={`px-2.5 py-1 rounded font-medium ${
                  tradeEnv === 'PAPER' ? 'bg-[#00A88F] text-white' : 'text-[#6B7280]'
                }`}
              >
                Paper
              </button>
              <button
                type="button"
                onClick={() => setTradeEnv('LIVE')}
                className={`px-2.5 py-1 rounded font-medium ${
                  tradeEnv === 'LIVE' ? 'bg-[#FF444F] text-white' : 'text-[#6B7280]'
                }`}
              >
                Live
              </button>
            </div>
          </div>

          {tradeEnv === 'LIVE' ? (
            <div className="p-3 rounded-md bg-[#FF4D5A]/10 border border-[#FF4D5A]/30 text-xs space-y-2">
              <div className="flex items-center gap-2 font-semibold text-[#FF4D5A]">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                Live Trading Locked by Safety Policy
              </div>
              <p className="text-[#20242B] dark:text-[#D1D5DB]">
                Real-money orders stay OFF by default until Deriv OAuth is connected, Demo testing passes, and the Risk & Accounts gate is unlocked.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#6B7280] mb-1">Contract Type</label>
                <select
                  value={contractType}
                  onChange={(e) => {
                    setContractType(e.target.value);
                    setProposal(null);
                  }}
                  className="w-full px-3 py-2 text-xs rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-white"
                >
                  <option value="CALL">Rise (CALL)</option>
                  <option value="PUT">Fall (PUT)</option>
                  <option value="DIGITMATCH" disabled={contracts ? !contracts.supportsMatch : false}>
                    Digit Matches {contracts && !contracts.supportsMatch ? '(Unsupported)' : ''}
                  </option>
                  <option value="DIGITDIFF" disabled={contracts ? !contracts.supportsDiffer : false}>
                    Digit Differs {contracts && !contracts.supportsDiffer ? '(Unsupported)' : ''}
                  </option>
                  <option value="DIGITEVEN" disabled={contracts ? !contracts.supportsEvenOdd : false}>
                    Digit Even
                  </option>
                  <option value="DIGITODD" disabled={contracts ? !contracts.supportsEvenOdd : false}>
                    Digit Odd
                  </option>
                </select>
              </div>

              {(contractType === 'DIGITMATCH' || contractType === 'DIGITDIFF') && (
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">Target Digit (0–9)</label>
                  <div className="grid grid-cols-5 gap-1">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setBarrier(String(d))}
                        className={`py-1.5 text-xs font-mono font-semibold rounded border ${
                          barrier === String(d)
                            ? 'bg-[#0866FF] text-white border-[#0866FF]'
                            : 'bg-[#F5F7FA] dark:bg-[#1D1F20] border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-white'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">Stake (USD)</label>
                  <input
                    type="number"
                    min="0.35"
                    step="0.5"
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6B7280] mb-1">
                    {contractType.startsWith('DIGIT') ? 'Duration (Ticks)' : 'Expiry (Sec)'}
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={contractType.startsWith('DIGIT') ? '1' : durationSec}
                    disabled={contractType.startsWith('DIGIT')}
                    onChange={(e) => setDurationSec(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleFetchQuote}
                disabled={proposalBusy}
                className="w-full py-2 px-3 text-xs font-semibold rounded-md border border-[#0866FF] text-[#0866FF] hover:bg-[#0866FF]/10 transition-colors"
              >
                {proposalBusy ? 'Fetching Live Deriv Quote…' : 'Check Live Deriv Payout'}
              </button>

              {proposal && (
                <div className="p-3 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] text-xs space-y-1 font-mono tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Ask Price</span>
                    <span className="font-semibold">${proposal.askPrice.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Broker Payout</span>
                    <span className="font-semibold text-[#00A88F]">${proposal.payout.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#6B7280]">Break-Even Win %</span>
                    <span className="font-semibold">{proposal.breakEvenProbPct}%</span>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handleOpenPaperTrade}
                disabled={tradeBusy}
                className="w-full py-2.5 px-4 text-xs font-semibold rounded-md bg-[#00A88F] hover:bg-[#00927C] text-white transition-colors flex items-center justify-center gap-2"
              >
                {contractType === 'PUT' ? <ArrowDownRight className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                {tradeBusy ? 'Opening…' : 'Open Paper Trade (Virtual)'}
              </button>

              {tradeMsg && <p className="text-xs text-[#6B7280] dark:text-[#D1D5DB]">{tradeMsg}</p>}
            </div>
          )}
        </div>

        {/* Paper Account Balance & Open Positions */}
        <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-[#20242B] dark:text-white">Paper Balance (Virtual)</h3>
              <div className="text-lg font-bold font-mono tabular-nums text-[#20242B] dark:text-white">
                ${paperAccount ? paperAccount.current_equity.toFixed(2) : '10000.00'}
              </div>
            </div>
            <div className="text-right text-xs font-mono tabular-nums">
              <div className="text-[#6B7280]">Net P/L</div>
              <div className={(paperAccount?.metrics.net_profit ?? 0) >= 0 ? 'text-[#00A88F] font-semibold' : 'text-[#FF4D5A] font-semibold'}>
                {(paperAccount?.metrics.net_profit ?? 0) >= 0 ? '+' : ''}
                ${(paperAccount?.metrics.net_profit ?? 0).toFixed(2)}
              </div>
            </div>
          </div>

          <div className="border-t border-[#E5E9EF] dark:border-[#2A2D30] pt-3 space-y-2 max-h-[260px] overflow-y-auto">
            {positions.length === 0 ? (
              <div className="text-xs text-[#6B7280] py-4 text-center flex flex-col items-center gap-1">
                <Activity className="w-4 h-4" />
                No paper trades yet.
              </div>
            ) : (
              positions.slice(0, 8).map((p) => {
                const canSettle = p.status === 'OPEN' && Date.now() >= new Date(p.expires_at).getTime();
                return (
                  <div
                    key={p.position_id}
                    className="p-2.5 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#20242B] dark:text-white truncate">
                        {p.symbol_code} · {p.contract_type}
                        {p.barrier ? ` (${p.barrier})` : ''}
                      </div>
                      <div className="text-[11px] font-mono text-[#6B7280]">
                        Stake ${p.stake.toFixed(2)} · Entry {p.entry_quote_str}
                      </div>
                    </div>
                    {p.status === 'OPEN' ? (
                      <button
                        type="button"
                        disabled={!canSettle || tradeBusy}
                        onClick={() => handleSettle(p.position_id)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium shrink-0 flex items-center gap-1 ${
                          canSettle
                            ? 'bg-[#0866FF] text-white hover:bg-[#0654D4]'
                            : 'bg-[#E5E9EF] dark:bg-[#2A2D30] text-[#6B7280]'
                        }`}
                      >
                        <Clock className="w-3 h-3" />
                        {canSettle ? 'Settle' : 'Wait'}
                      </button>
                    ) : (
                      <span
                        className={`font-mono font-semibold tabular-nums shrink-0 ${
                          (p.profit_loss ?? 0) >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                        }`}
                      >
                        {(p.profit_loss ?? 0) >= 0 ? '+' : ''}
                        ${(p.profit_loss ?? 0).toFixed(2)}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'buy' | 'sell' | 'neutral';
}) {
  const color =
    tone === 'buy'
      ? 'text-[#00A88F]'
      : tone === 'sell'
        ? 'text-[#FF4D5A]'
        : 'text-[#20242B] dark:text-white';
  return (
    <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-3">
      <div className="text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">{label}</div>
      <div className={`text-sm font-bold font-mono tabular-nums mt-0.5 truncate ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-[#6B7280] truncate mt-0.5">{sub}</div>}
    </div>
  );
}

function ChartSvg({
  candles,
  mode,
  pipDecimals,
  hoverIdx,
  onHover,
}: {
  candles: CandleBar[];
  mode: 'candles' | 'line';
  pipDecimals: number;
  hoverIdx: number | null;
  onHover: (idx: number | null) => void;
}) {
  const width = 760;
  const height = 320;
  const padRight = 68;
  const padTop = 16;
  const padBottom = 22;
  const plotW = width - padRight - 10;
  const plotH = height - padTop - padBottom;

  const minP = Math.min(...candles.map((c) => c.low));
  const maxP = Math.max(...candles.map((c) => c.high));
  const span = maxP - minP || 1;
  const toY = (price: number) => padTop + ((maxP - price) / span) * plotH;
  const stepX = plotW / Math.max(1, candles.length);

  const linePath = candles
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${(10 + i * stepX + stepX / 2).toFixed(1)} ${toY(c.close).toFixed(1)}`)
    .join(' ');

  const gridLevels = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-full select-none"
      onMouseLeave={() => onHover(null)}
    >
      {gridLevels.map((frac) => {
        const price = maxP - frac * span;
        const y = padTop + frac * plotH;
        return (
          <g key={frac}>
            <line x1={10} y1={y} x2={width - padRight} y2={y} stroke="currentColor" className="text-[#E5E9EF] dark:text-[#232629]" strokeDasharray="3 3" />
            <text
              x={width - padRight + 6}
              y={y + 4}
              fontSize="10"
              className="fill-[#6B7280] font-mono tabular-nums"
            >
              {price.toFixed(pipDecimals)}
            </text>
          </g>
        );
      })}

      {mode === 'line' ? (
        <path d={linePath} fill="none" stroke="#0866FF" strokeWidth="2" />
      ) : (
        candles.map((c, i) => {
          const cx = 10 + i * stepX + stepX / 2;
          const up = c.close >= c.open;
          const color = up ? '#00A88F' : '#FF4D5A';
          const yTop = toY(Math.max(c.open, c.close));
          const yBot = toY(Math.min(c.open, c.close));
          const bodyH = Math.max(2, yBot - yTop);
          const candleW = Math.max(2, stepX * 0.62);
          return (
            <g key={c.epoch}>
              <line x1={cx} y1={toY(c.high)} x2={cx} y2={toY(c.low)} stroke={color} strokeWidth="1.2" />
              <rect x={cx - candleW / 2} y={yTop} width={candleW} height={bodyH} fill={color} rx="1" />
            </g>
          );
        })
      )}

      {/* Crosshair + invisible hover columns */}
      {hoverIdx !== null && candles[hoverIdx] && (
        <line
          x1={10 + hoverIdx * stepX + stepX / 2}
          y1={padTop}
          x2={10 + hoverIdx * stepX + stepX / 2}
          y2={height - padBottom}
          stroke="#08B9E6"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      )}

      {candles.map((c, i) => (
        <rect
          key={`hit-${c.epoch}`}
          x={10 + i * stepX}
          y={0}
          width={stepX}
          height={height}
          fill="transparent"
          onMouseEnter={() => onHover(i)}
        />
      ))}
    </svg>
  );
}
