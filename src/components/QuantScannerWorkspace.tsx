import React, { useState } from 'react';
import { BarChart3, Layers, Radar, RefreshCw, Search } from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type { ActiveSymbol, QuantAnalysis } from '../types/dqi';

interface QuantScannerWorkspaceProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  onJumpToTerminal: () => void;
}

export const QuantScannerWorkspace: React.FC<QuantScannerWorkspaceProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  onJumpToTerminal,
}) => {
  const [timeframe, setTimeframe] = useState('M15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<QuantAnalysis | null>(null);
  const [mtf, setMtf] = useState<{
    consensus: 'BUY' | 'SELL' | 'MIXED';
    consensus_score: number;
    alignment: number;
    timeframes: Record<string, QuantAnalysis>;
  } | null>(null);

  const [scanResults, setScanResults] = useState<
    Array<QuantAnalysis | { symbol: string; direction: 'ERROR'; error: string }>
  >([]);
  const [scanTime, setScanTime] = useState<string | null>(null);
  const [dirFilter, setDirFilter] = useState<'ALL' | 'BUY' | 'SELL' | 'NEUTRAL'>('ALL');
  const [scanSearch, setScanSearch] = useState('');

  const [backtest, setBacktest] = useState<{
    metrics: Record<string, number | string | null>;
    equity_curve: number[];
    trades: Array<{ entry_epoch: number; side: string; entry: number; exit: number; pnl: number; regime: string }>;
    disclaimer: string;
  } | null>(null);

  const [walkForward, setWalkForward] = useState<{
    fold_count: number;
    method: string;
    folds: Array<{
      fold: number;
      selected_threshold: number;
      out_of_sample: Record<string, number | string | null> | null;
    }>;
  } | null>(null);

  async function runDeepAnalysis() {
    setBusy(true);
    setError(null);
    try {
      const [single, multi] = await Promise.all([
        dqiApi.analyzeQuant(selectedSymbol, timeframe, 250),
        dqiApi.analyzeMultiTimeframe(selectedSymbol, ['M5', 'M15', 'H1', 'H4']),
      ]);
      setAnalysis(single);
      setMtf(multi);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quant analysis failed');
    } finally {
      setBusy(false);
    }
  }

  async function runMarketScan() {
    if (!symbols.length) return;
    setBusy(true);
    setError(null);
    try {
      // Bounded batch up to 24 open/popular Deriv symbols to prevent upstream throttling
      const subset = symbols.filter((s) => s.exchange_is_open === 1).slice(0, 24).map((s) => s.symbol);
      const res = await dqiApi.scanMarkets(subset.length ? subset : symbols.slice(0, 20).map((s) => s.symbol), timeframe);
      setScanResults(res.results);
      setScanTime(res.scannedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Market scan failed');
    } finally {
      setBusy(false);
    }
  }

  async function runResearchBacktest() {
    setBusy(true);
    setError(null);
    try {
      const res = await dqiApi.runBacktest({
        symbol: selectedSymbol,
        timeframe,
        count: 500,
        initial_equity: 10000,
        risk_fraction: 0.005,
        fee_rate: 0.0002,
        slippage_bps: 2,
        threshold: 0.35,
      });
      setBacktest(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backtest failed');
    } finally {
      setBusy(false);
    }
  }

  async function runWalkForwardCheck() {
    setBusy(true);
    setError(null);
    try {
      const res = await dqiApi.runWalkForward(selectedSymbol, timeframe);
      setWalkForward(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Walk-forward failed');
    } finally {
      setBusy(false);
    }
  }

  const filteredScan = scanResults.filter((r) => {
    if (dirFilter !== 'ALL' && r.direction !== dirFilter) return false;
    if (scanSearch.trim()) {
      return r.symbol.toLowerCase().includes(scanSearch.trim().toLowerCase());
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* TOP TOOLBAR */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[11px] text-[#6B7280] mb-1">Symbol</label>
            <select
              value={selectedSymbol}
              onChange={(e) => onSelectSymbol(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
            >
              {symbols.slice(0, 120).map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.display_name} ({s.symbol})
                </option>
              ))}
              {symbols.length === 0 && <option value={selectedSymbol}>{selectedSymbol}</option>}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-[#6B7280] mb-1">Timeframe</label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
            >
              {['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={runDeepAnalysis}
            className="px-3.5 py-2 text-xs font-semibold rounded-md bg-[#0866FF] hover:bg-[#0654D4] text-white flex items-center gap-1.5"
          >
            <Layers className="w-3.5 h-3.5" />
            Analyze {selectedSymbol}
          </button>
          <button
            type="button"
            disabled={busy || symbols.length === 0}
            onClick={runMarketScan}
            className="px-3.5 py-2 text-xs font-semibold rounded-md bg-[#101820] hover:bg-[#20242B] text-white flex items-center gap-1.5"
          >
            <Radar className="w-3.5 h-3.5" />
            Scan Top 24 Markets
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={runResearchBacktest}
            className="px-3.5 py-2 text-xs font-semibold rounded-md bg-[#FF444F] hover:bg-[#EB3E48] text-white flex items-center gap-1.5"
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Backtest
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-[#FF4D5A]/10 border border-[#FF4D5A]/30 text-xs text-[#FF4D5A]">
          {error}
        </div>
      )}

      {/* MULTI-TIMEFRAME & TECHNICAL INDICATORS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-2.5">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">Multi-Timeframe Consensus</h2>
              <p className="text-xs text-[#6B7280]">M5 · M15 · H1 · H4 alignment check</p>
            </div>
            {mtf && (
              <span
                className={`text-sm font-bold font-mono ${
                  mtf.consensus === 'BUY' ? 'text-[#00A88F]' : mtf.consensus === 'SELL' ? 'text-[#FF4D5A]' : 'text-[#6B7280]'
                }`}
              >
                {mtf.consensus} ({(mtf.alignment * 100).toFixed(0)}%)
              </span>
            )}
          </div>

          {!mtf ? (
            <div className="py-10 text-center text-xs text-[#6B7280]">
              Click <strong>Analyze {selectedSymbol}</strong> to inspect all timeframes and 11 indicators.
            </div>
          ) : (
            <div className="space-y-2">
              {Object.values(mtf.timeframes).map((item) => (
                <div
                  key={item.timeframe}
                  className="p-2.5 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] flex items-center justify-between text-xs font-mono tabular-nums"
                >
                  <div>
                    <span className="font-bold text-[#20242B] dark:text-white">{item.timeframe}</span>
                    <span className="text-[#6B7280] ml-2 font-sans">{item.regime.replaceAll('_', ' ')}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[#6B7280]">RSI {item.indicators.rsi14?.toFixed(1) ?? '—'}</span>
                    <span
                      className={`font-bold ${
                        item.direction === 'BUY' ? 'text-[#00A88F]' : item.direction === 'SELL' ? 'text-[#FF4D5A]' : 'text-[#6B7280]'
                      }`}
                    >
                      {item.direction}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-2.5">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
                Technical Indicators & Signal Evidence ({timeframe})
              </h2>
              <p className="text-xs text-[#6B7280]">
                {analysis
                  ? `Calibration: ${analysis.calibration_status === 'EMPIRICALLY_FITTED' ? 'Platt fitted' : 'Raw model score (uncalibrated)'}`
                  : 'All 11 deterministic indicators'}
              </p>
            </div>
            {analysis?.invalidation_level && (
              <span className="text-xs font-mono text-[#6B7280]">
                Invalidation: {analysis.invalidation_level}
              </span>
            )}
          </div>

          {!analysis ? (
            <div className="py-10 text-center text-xs text-[#6B7280]">No active analysis loaded yet.</div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono tabular-nums">
                <MiniMetric label="SMA 20" val={analysis.indicators.sma20?.toFixed(4) ?? '—'} />
                <MiniMetric label="EMA 12 / 26" val={analysis.indicators.ema12 && analysis.indicators.ema26 ? `${analysis.indicators.ema12.toFixed(2)} / ${analysis.indicators.ema26.toFixed(2)}` : '—'} />
                <MiniMetric label="RSI (14)" val={analysis.indicators.rsi14?.toFixed(2) ?? '—'} />
                <MiniMetric label="ATR (14)" val={analysis.indicators.atr14?.toFixed(4) ?? '—'} />
                <MiniMetric label="ADX (14)" val={analysis.indicators.adx14?.toFixed(2) ?? '—'} />
                <MiniMetric label="CCI (20)" val={analysis.indicators.cci20?.toFixed(1) ?? '—'} />
                <MiniMetric label="Stoch K/D" val={analysis.indicators.stochastic ? `${analysis.indicators.stochastic.k} / ${analysis.indicators.stochastic.d}` : '—'} />
                <MiniMetric label="MACD Hist" val={analysis.indicators.macd?.histogram.toFixed(4) ?? '—'} />
              </div>
              <div className="text-xs text-[#6B7280] pt-1">
                Evidence: {analysis.reasons.length ? analysis.reasons.join(' · ') : 'Neutral range conditions'}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ALL-MARKET SCANNER TABLE */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E5E9EF] dark:border-[#2A2D30] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">Dynamic Market Scanner</h2>
            <p className="text-xs text-[#6B7280]">
              {scanTime ? `Last updated ${new Date(scanTime).toLocaleTimeString()}` : 'Click Scan Top 24 Markets to rank live signals'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#6B7280] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={scanSearch}
                onChange={(e) => setScanSearch(e.target.value)}
                placeholder="Filter symbol"
                className="pl-7 pr-2.5 py-1 text-xs rounded bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
              />
            </div>
            <div className="flex items-center gap-1 bg-[#F5F7FA] dark:bg-[#1D1F20] p-0.5 rounded text-xs">
              {(['ALL', 'BUY', 'SELL', 'NEUTRAL'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirFilter(d)}
                  className={`px-2 py-1 rounded font-medium ${
                    dirFilter === d ? 'bg-[#0866FF] text-white' : 'text-[#6B7280]'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F5F7FA] dark:bg-[#1D1F20] text-[#6B7280] border-b border-[#E5E9EF] dark:border-[#2A2D30]">
              <tr>
                <th className="py-2.5 px-4 font-medium">Symbol</th>
                <th className="py-2.5 px-4 font-medium">Direction</th>
                <th className="py-2.5 px-4 font-medium text-right">Raw Score</th>
                <th className="py-2.5 px-4 font-medium text-right">RSI (14)</th>
                <th className="py-2.5 px-4 font-medium">Market Regime</th>
                <th className="py-2.5 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E9EF] dark:divide-[#2A2D30] font-mono tabular-nums">
              {filteredScan.map((r) => {
                const isErr = r.direction === 'ERROR';
                return (
                  <tr key={r.symbol} className="hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20]">
                    <td className="py-2.5 px-4 font-semibold text-[#20242B] dark:text-white">{r.symbol}</td>
                    <td
                      className={`py-2.5 px-4 font-bold ${
                        r.direction === 'BUY'
                          ? 'text-[#00A88F]'
                          : r.direction === 'SELL'
                            ? 'text-[#FF4D5A]'
                            : 'text-[#6B7280]'
                      }`}
                    >
                      {r.direction}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      {!isErr ? `${((r as QuantAnalysis).calibrated_confidence * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      {!isErr && (r as QuantAnalysis).indicators.rsi14 !== null
                        ? (r as QuantAnalysis).indicators.rsi14!.toFixed(1)
                        : '—'}
                    </td>
                    <td className="py-2.5 px-4 font-sans text-[#6B7280]">
                      {!isErr ? (r as QuantAnalysis).regime.replaceAll('_', ' ') : (r as any).error}
                    </td>
                    <td className="py-2.5 px-4 text-right font-sans">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectSymbol(r.symbol);
                          onJumpToTerminal();
                        }}
                        className="text-xs font-medium text-[#0866FF] hover:underline"
                      >
                        Open Chart
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filteredScan.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center font-sans text-[#6B7280]">
                    {scanResults.length === 0 ? 'No scan run yet.' : 'No rows match your filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* BACKTEST & WALK-FORWARD VALIDATION */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-3">
          <div>
            <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
              Historical Backtest & Out-of-Sample Walk-Forward Validation
            </h2>
            <p className="text-xs text-[#6B7280]">
              Strict next-bar execution · 0.5% ATR-normalized risk · simulated fees & slippage
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={runResearchBacktest}
              className="px-3 py-1.5 text-xs font-semibold rounded bg-[#0866FF] text-white"
            >
              Run Backtest (500 bars)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={runWalkForwardCheck}
              className="px-3 py-1.5 text-xs font-semibold rounded border border-[#E5E9EF] dark:border-[#2A2D30] hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20] flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              Walk-Forward (600 bars)
            </button>
          </div>
        </div>

        {backtest && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 text-xs font-mono tabular-nums">
              <MiniMetric label="Total Return" val={`${(Number(backtest.metrics.total_return || 0) * 100).toFixed(2)}%`} />
              <MiniMetric label="Win Rate" val={`${(Number(backtest.metrics.win_rate || 0) * 100).toFixed(1)}%`} />
              <MiniMetric label="Trades" val={String(backtest.metrics.trade_count ?? 0)} />
              <MiniMetric label="Max Drawdown" val={`${(Number(backtest.metrics.max_drawdown || 0) * 100).toFixed(2)}%`} />
              <MiniMetric label="Profit Factor" val={String(backtest.metrics.profit_factor ?? '—')} />
              <MiniMetric label="Ending Equity" val={`$${Number(backtest.metrics.ending_equity || 10000).toFixed(2)}`} />
            </div>
            <p className="text-[11px] text-[#6B7280]">{backtest.disclaimer}</p>
          </div>
        )}

        {walkForward && (
          <div className="overflow-x-auto border-t border-[#E5E9EF] dark:border-[#2A2D30] pt-3">
            <p className="text-xs text-[#6B7280] mb-2">
              {walkForward.fold_count} chronological folds · {walkForward.method}
            </p>
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead className="text-[#6B7280] border-b border-[#E5E9EF] dark:border-[#2A2D30]">
                <tr>
                  <th className="py-2 pr-4">Fold</th>
                  <th className="py-2 pr-4 text-right">Threshold</th>
                  <th className="py-2 pr-4 text-right">OOS Return</th>
                  <th className="py-2 pr-4 text-right">OOS Drawdown</th>
                  <th className="py-2 pr-4 text-right">OOS Trades</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E9EF] dark:divide-[#2A2D30]">
                {walkForward.folds.map((f) => (
                  <tr key={f.fold}>
                    <td className="py-2 pr-4">Fold {f.fold}</td>
                    <td className="py-2 pr-4 text-right">{f.selected_threshold}</td>
                    <td className="py-2 pr-4 text-right">
                      {f.out_of_sample ? `${(Number(f.out_of_sample.total_return || 0) * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {f.out_of_sample ? `${(Number(f.out_of_sample.max_drawdown || 0) * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className="py-2 pr-4 text-right">{f.out_of_sample?.trade_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

function MiniMetric({ label, val }: { label: string; val: string }) {
  return (
    <div className="p-2.5 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]">
      <div className="text-[11px] font-sans text-[#6B7280]">{label}</div>
      <div className="text-xs font-bold text-[#20242B] dark:text-white mt-0.5 truncate">{val}</div>
    </div>
  );
}
