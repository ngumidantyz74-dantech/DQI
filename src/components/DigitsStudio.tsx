import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  RefreshCw,
  ShieldCheck,
  Waves,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type { ActiveSymbol, DigitsFullResponse, LiveTickEvent } from '../types/dqi';

interface DigitsStudioProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  latestTick: LiveTickEvent | null;
  liveTapeBuffer: LiveTickEvent[];
}

const WINDOW_OPTIONS = [25, 50, 100, 250, 500, 1000];

export const DigitsStudio: React.FC<DigitsStudioProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
  latestTick,
  liveTapeBuffer,
}) => {
  const [windowSize, setWindowSize] = useState(100);
  const [activeTab, setActiveTab] = useState<'DIGITMATCH' | 'DIGITDIFF'>('DIGITDIFF');
  const [data, setData] = useState<DigitsFullResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual Deriv Bot Builder setup handoff fields (user explicitly enters stake)
  const [setupContract, setSetupContract] = useState<
    'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITEVEN' | 'DIGITODD'
  >('DIGITDIFF');
  const [setupBarrier, setSetupBarrier] = useState('5');
  const [setupTicks, setSetupTicks] = useState('1');
  const [setupStake, setSetupStake] = useState('1.00');
  const [copied, setCopied] = useState(false);

  const digitEligibleSymbols = useMemo(() => {
    // Volatility / Synthetic symbols reliably support digits; still allow any symbol and verify via contracts_for
    const synthetics = symbols.filter((s) => s.market === 'synthetic_index' || s.symbol.startsWith('R_') || s.symbol.startsWith('1HZ'));
    return synthetics.length > 0 ? synthetics : symbols;
  }, [symbols]);

  async function refreshDigits() {
    setLoading(true);
    setError(null);
    try {
      const stakeNum = Math.max(0.35, Number(setupStake) || 1);
      const durNum = Math.min(10, Math.max(1, Number(setupTicks) || 1));
      const res = await dqiApi.analyzeDigits(selectedSymbol, windowSize, stakeNum, durNum);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to analyze digits stream');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshDigits();
  }, [selectedSymbol, windowSize]);

  // Refresh stats periodically as live ticks arrive
  useEffect(() => {
    if (!latestTick || latestTick.symbol !== selectedSymbol) return;
    if (liveTapeBuffer.length % 5 === 0) {
      refreshDigits();
    }
  }, [liveTapeBuffer.length]);

  const currentObservedDigit =
    latestTick && latestTick.symbol === selectedSymbol
      ? latestTick.lastDigit
      : data?.analytics.latestObservedDigit ?? null;

  const currentQuoteStr =
    latestTick && latestTick.symbol === selectedSymbol
      ? latestTick.rawQuote
      : data?.analytics.latestQuote ?? '—';

  const currentTimeStr =
    latestTick && latestTick.symbol === selectedSymbol
      ? new Date(latestTick.epoch * 1000).toLocaleTimeString()
      : data?.analytics.asOfTimestamp
        ? new Date(data.analytics.asOfTimestamp).toLocaleTimeString()
        : '—';

  const tapeDigits = useMemo(() => {
    const serverTape = data?.analytics.tape || [];
    const liveMatching = liveTapeBuffer.filter((t) => t.symbol === selectedSymbol);
    const mergedMap = new Map<string, { digit: number; quote: string; epoch: number }>();
    for (const item of serverTape) {
      mergedMap.set(`${item.epoch}-${item.quote}`, { digit: item.digit, quote: item.quote, epoch: item.epoch });
    }
    for (const item of liveMatching) {
      mergedMap.set(`${item.epoch}-${item.rawQuote}`, { digit: item.lastDigit, quote: item.rawQuote, epoch: item.epoch });
    }
    return Array.from(mergedMap.values())
      .sort((a, b) => a.epoch - b.epoch)
      .slice(-36);
  }, [data, liveTapeBuffer, selectedSymbol]);

  const matchSupported = data?.contractSupport.supportsMatch ?? true;
  const differSupported = data?.contractSupport.supportsDiffer ?? true;
  const candidates = activeTab === 'DIGITMATCH' ? data?.matchCandidates || [] : data?.differCandidates || [];

  const activeProposal =
    setupContract === 'DIGITMATCH'
      ? data?.proposals.match
      : setupContract === 'DIGITDIFF'
        ? data?.proposals.differ
        : null;

  function handleCopySetup() {
    const text = [
      `DQI Manual Deriv Bot Setup`,
      `Market: ${selectedSymbol}`,
      `Contract: ${setupContract}`,
      `Barrier Digit: ${['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(setupContract) ? setupBarrier : 'N/A'}`,
      `Duration: ${setupTicks} tick(s)`,
      `User Stake: $${Number(setupStake || 0).toFixed(2)}`,
      `Observed Last Digit: ${currentObservedDigit ?? '—'} (Quote: ${currentQuoteStr})`,
      `Lookback Window: ${windowSize} ticks · Volatility: ${data?.volatility.regime || 'UNKNOWN'}`,
      `Note: Descriptive historical statistics only; does not predict next tick.`,
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      {/* TOP CONTROL STRIP */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[11px] text-[#6B7280] mb-1">Market</label>
            <select
              value={selectedSymbol}
              onChange={(e) => onSelectSymbol(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-white"
            >
              {digitEligibleSymbols.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.display_name} ({s.symbol})
                </option>
              ))}
              {digitEligibleSymbols.length === 0 && <option value={selectedSymbol}>{selectedSymbol}</option>}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-[#6B7280] mb-1">Lookback Window</label>
            <div className="flex items-center gap-1 bg-[#F5F7FA] dark:bg-[#1D1F20] p-1 rounded-md">
              {WINDOW_OPTIONS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWindowSize(w)}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                    windowSize === w
                      ? 'bg-[#0866FF] text-white'
                      : 'text-[#6B7280] hover:text-[#20242B] dark:hover:text-white'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="text-[11px] text-[#6B7280]">Volatility State</div>
            <div className="text-xs font-semibold font-mono flex items-center justify-end gap-1.5 mt-0.5">
              <Waves className="w-3.5 h-3.5 text-[#08B9E6]" />
              <span>{data?.volatility.regime.replaceAll('_', ' ') || 'CHECKING'}</span>
              {data?.volatility.rawWindowVolBps !== null && data?.volatility.rawWindowVolBps !== undefined && (
                <span className="text-[#6B7280]">({data.volatility.rawWindowVolBps} bps)</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={refreshDigits}
            disabled={loading}
            className="px-3 py-2 text-xs font-medium rounded-md border border-[#E5E9EF] dark:border-[#2A2D30] hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20] flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-[#FF4D5A]/10 border border-[#FF4D5A]/30 text-xs text-[#FF4D5A]">
          {error}
        </div>
      )}

      {/* HERO ROW: OBSERVED LAST DIGIT + LIVE DIGIT TAPE + SPLIT BARS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-3 bg-[#101820] text-white rounded-lg p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#9CA3AF]">OBSERVED LAST DIGIT</span>
            <span className="text-[11px] font-mono text-[#08B9E6]">
              Precision {data?.analytics.quotePrecision ?? latestTick?.pipSize ?? '—'}dp
            </span>
          </div>

          <div className="my-4 flex items-baseline gap-4">
            <div className="w-16 h-16 rounded-lg bg-[#FF444F] flex items-center justify-center text-4xl font-bold font-mono tabular-nums">
              {currentObservedDigit ?? '—'}
            </div>
            <div>
              <div className="text-lg font-bold font-mono tabular-nums">{currentQuoteStr}</div>
              <div className="text-xs text-[#9CA3AF] font-mono">{currentTimeStr}</div>
            </div>
          </div>

          <div className="text-[11px] text-[#9CA3AF] pt-2 border-t border-white/10">
            Last received tick only — does not predict the next digit.
          </div>
        </div>

        <div className="lg:col-span-9 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
                Recent Digit Sequence (Newest on Right)
              </h2>
              <p className="text-xs text-[#6B7280]">
                Sample {data?.analytics.sampleCount ?? 0} ticks · Entropy {data?.analytics.entropyBits ?? '—'} / 3.32 bits
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
              <span>
                Even <strong className="text-[#0866FF]">{data?.analytics.evenPct ?? 0}%</strong> / Odd{' '}
                <strong>{data?.analytics.oddPct ?? 0}%</strong>
              </span>
              <span>
                Over 4 <strong className="text-[#00A88F]">{data?.analytics.over4Pct ?? 0}%</strong> / Under 5{' '}
                <strong>{data?.analytics.under5Pct ?? 0}%</strong>
              </span>
            </div>
          </div>

          {/* 36-tick Tape */}
          <div className="flex flex-wrap gap-1.5">
            {tapeDigits.length === 0 ? (
              <span className="text-xs text-[#6B7280]">Waiting for Deriv ticks…</span>
            ) : (
              tapeDigits.map((item, idx) => {
                const isLatest = idx === tapeDigits.length - 1;
                const isEven = item.digit % 2 === 0;
                return (
                  <div
                    key={`${item.epoch}-${idx}`}
                    title={`Quote ${item.quote} at ${new Date(item.epoch * 1000).toLocaleTimeString()}`}
                    className={`w-8 h-8 rounded flex items-center justify-center text-xs font-mono font-bold tabular-nums transition-transform ${
                      isLatest
                        ? 'bg-[#FF444F] text-white ring-2 ring-[#FF444F]/40 scale-105'
                        : isEven
                          ? 'bg-[#0866FF]/10 text-[#0866FF] dark:bg-[#0866FF]/20 dark:text-[#60A5FA]'
                          : 'bg-[#F5F7FA] dark:bg-[#1D1F20] text-[#20242B] dark:text-[#E5E7EB] border border-[#E5E9EF] dark:border-[#2A2D30]'
                    }`}
                  >
                    {item.digit}
                  </div>
                );
              })
            )}
          </div>

          {/* Quality / Chi-Square Note */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E5E9EF] dark:border-[#2A2D30] text-xs">
            <span className="text-[#6B7280]">
              {data?.analytics.dataQuality === 'INSUFFICIENT_DATA' ? (
                <span className="text-[#FFAD3A] font-medium">INSUFFICIENT DATA · {data.analytics.qualityNote}</span>
              ) : (
                <span>{data?.analytics.chiSquareNote || 'Computing distribution…'}</span>
              )}
            </span>
            {data?.analytics.currentStreakDigit !== null && data && (
              <span className="font-mono text-[#6B7280]">
                Latest repeat streak: Digit {data.analytics.currentStreakDigit} ×{data.analytics.currentStreakLength}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 0–9 FREQUENCY BARS + MANUAL BOT SETUP CARD */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 0-9 Frequency Histogram */}
        <div className="lg:col-span-8 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
                0–9 Frequency Distribution vs 10.0% Fair Baseline
              </h2>
              <p className="text-xs text-[#6B7280]">
                Past observations only — small deviations are normal random variance
              </p>
            </div>
            {data && (
              <div className="text-xs text-[#6B7280] font-mono">
                Top Recent: {data.analytics.recentLeaders.slice(0, 3).map((l) => `${l.digit}(${l.percentage}%)`).join(' · ')}
              </div>
            )}
          </div>

          <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 pt-2">
            {(data?.analytics.digits || []).map((d) => {
              const heightPct = Math.min(100, Math.max(8, (d.percentage / 22) * 100));
              const aboveBase = d.percentage > 10;
              return (
                <div
                  key={d.digit}
                  className="flex flex-col items-center p-2 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                >
                  <span className="text-xs font-mono font-bold tabular-nums text-[#20242B] dark:text-white">
                    {d.percentage.toFixed(1)}%
                  </span>
                  <div className="w-full h-28 flex items-end justify-center my-2 relative">
                    {/* 10% Reference Line */}
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-[#6B7280]/50"
                      style={{ bottom: `${(10 / 22) * 100}%` }}
                    />
                    <div
                      className={`w-6 rounded-t transition-all ${
                        d.digit === currentObservedDigit
                          ? 'bg-[#FF444F]'
                          : aboveBase
                            ? 'bg-[#00A88F]'
                            : 'bg-[#0866FF]'
                      }`}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <div className="w-7 h-7 rounded bg-[#101820] text-white flex items-center justify-center text-xs font-mono font-bold">
                    {d.digit}
                  </div>
                  <span className="text-[10px] font-mono text-[#6B7280] mt-1">{d.count}×</span>
                  <span className="text-[10px] font-mono text-[#6B7280]">
                    {d.lastSeenTicksAgo === null ? '—' : `${d.lastSeenTicksAgo} ago`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Manual Deriv Bot Builder Setup Handoff */}
        <div className="lg:col-span-4 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-2.5">
            <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
              Manual Bot Builder Setup Card
            </h2>
            <p className="text-xs text-[#6B7280]">
              Copy exact parameters for your manual Deriv Bot Builder entry
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] text-[#6B7280] mb-1">Contract Family</label>
              <select
                value={setupContract}
                onChange={(e) => setSetupContract(e.target.value as any)}
                className="w-full px-2.5 py-1.5 text-xs rounded bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
              >
                <option value="DIGITDIFF" disabled={!differSupported}>
                  Differs (DIGITDIFF)
                </option>
                <option value="DIGITMATCH" disabled={!matchSupported}>
                  Matches (DIGITMATCH)
                </option>
                <option value="DIGITOVER">Over (DIGITOVER)</option>
                <option value="DIGITUNDER">Under (DIGITUNDER)</option>
                <option value="DIGITEVEN">Even (DIGITEVEN)</option>
                <option value="DIGITODD">Odd (DIGITODD)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[#6B7280] mb-1">Barrier Digit</label>
              <select
                value={setupBarrier}
                disabled={setupContract === 'DIGITEVEN' || setupContract === 'DIGITODD'}
                onChange={(e) => setSetupBarrier(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
              >
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>
                    Digit {n}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[#6B7280] mb-1">Ticks (1–10)</label>
              <input
                type="number"
                min="1"
                max="10"
                value={setupTicks}
                onChange={(e) => setSetupTicks(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[#6B7280] mb-1">Your Stake ($)</label>
              <input
                type="number"
                min="0.35"
                step="0.5"
                value={setupStake}
                onChange={(e) => setSetupStake(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
              />
            </div>
          </div>

          <div className="p-3 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] text-xs font-mono space-y-1 tabular-nums">
            <div className="flex justify-between">
              <span className="text-[#6B7280]">Market / Tick</span>
              <span>
                {selectedSymbol} · Obs {currentObservedDigit ?? '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#6B7280]">Live Proposal Payout</span>
              <span className="text-[#00A88F] font-semibold">
                {activeProposal ? `$${activeProposal.payout.toFixed(2)}` : 'Check Match/Differ table'}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCopySetup}
            className="w-full py-2.5 px-4 text-xs font-semibold rounded-md bg-[#FF444F] hover:bg-[#EB3E48] text-white transition-colors flex items-center justify-center gap-2"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Setup Copied to Clipboard' : 'Copy Manual Setup Card'}
          </button>
        </div>
      </div>

      {/* MATCH & DIFFER CANDIDATE TABLES */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E5E9EF] dark:border-[#2A2D30] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#20242B] dark:text-white">
              Match & Differ Candidate Evaluation
            </h2>
            <p className="text-xs text-[#6B7280]">
              Compares empirical 95% confidence lower bound against live Deriv proposal break-even probability
            </p>
          </div>

          <div className="flex items-center gap-1 bg-[#F5F7FA] dark:bg-[#1D1F20] p-1 rounded-md">
            <button
              type="button"
              disabled={!differSupported}
              onClick={() => setActiveTab('DIGITDIFF')}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                activeTab === 'DIGITDIFF'
                  ? 'bg-[#0866FF] text-white'
                  : 'text-[#6B7280] disabled:opacity-40'
              }`}
            >
              DIGITDIFF {!differSupported && '(Unsupported)'}
            </button>
            <button
              type="button"
              disabled={!matchSupported}
              onClick={() => setActiveTab('DIGITMATCH')}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                activeTab === 'DIGITMATCH'
                  ? 'bg-[#0866FF] text-white'
                  : 'text-[#6B7280] disabled:opacity-40'
              }`}
            >
              DIGITMATCH {!matchSupported && '(Unsupported)'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F5F7FA] dark:bg-[#1D1F20] text-[#6B7280] border-b border-[#E5E9EF] dark:border-[#2A2D30]">
              <tr>
                <th className="py-2.5 px-4 font-medium">Digit</th>
                <th className="py-2.5 px-4 font-medium text-right">Observed Win %</th>
                <th className="py-2.5 px-4 font-medium text-right">95% Confidence Band</th>
                <th className="py-2.5 px-4 font-medium text-right">Live Ask / Payout</th>
                <th className="py-2.5 px-4 font-medium text-right">Break-Even %</th>
                <th className="py-2.5 px-4 font-medium text-right">Est. EV</th>
                <th className="py-2.5 px-4 font-medium">Assessment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E5E9EF] dark:divide-[#2A2D30] font-mono tabular-nums">
              {candidates.map((c) => (
                <tr
                  key={c.barrierDigit}
                  onClick={() => {
                    setSetupContract(activeTab);
                    setSetupBarrier(String(c.barrierDigit));
                  }}
                  className="hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20] cursor-pointer"
                >
                  <td className="py-2.5 px-4 font-bold text-[#20242B] dark:text-white">
                    Digit {c.barrierDigit}
                  </td>
                  <td className="py-2.5 px-4 text-right">{c.observedFrequencyPct.toFixed(2)}%</td>
                  <td className="py-2.5 px-4 text-right text-[#6B7280]">
                    {c.ciLowPct.toFixed(1)}% – {c.ciHighPct.toFixed(1)}%
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    {c.proposalAskPrice !== null && c.proposalPayout !== null
                      ? `$${c.proposalAskPrice.toFixed(2)} / $${c.proposalPayout.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    {c.breakEvenProbPct !== null ? `${c.breakEvenProbPct.toFixed(2)}%` : '—'}
                  </td>
                  <td
                    className={`py-2.5 px-4 text-right font-semibold ${
                      (c.estimatedEv ?? 0) > 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'
                    }`}
                  >
                    {c.estimatedEv !== null ? `$${c.estimatedEv.toFixed(3)}` : '—'}
                  </td>
                  <td className="py-2.5 px-4 font-sans">
                    <span className="inline-flex items-center gap-1.5 text-xs text-[#6B7280]">
                      {c.status === 'POTENTIAL_RESEARCH_CANDIDATE' ? (
                        <ShieldCheck className="w-3.5 h-3.5 text-[#00A88F]" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5 text-[#FFAD3A]" />
                      )}
                      {c.reason}
                    </span>
                  </td>
                </tr>
              ))}
              {candidates.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center font-sans text-[#6B7280]">
                    Loading live Deriv ticks and proposal pricing…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
