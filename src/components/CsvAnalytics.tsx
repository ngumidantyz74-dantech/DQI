import React, { useMemo, useState } from 'react';
import { Download, Search, Upload } from 'lucide-react';
import { BotStrategyConfig, CsvSummaryStats, CsvTransaction } from '../types/deriv';
import { replayStrategyOnCsv } from '../utils/csvParser';

interface CsvAnalyticsProps {
  transactions: CsvTransaction[];
  stats: CsvSummaryStats;
  csvFileName: string;
  strategies: BotStrategyConfig[];
  onUploadCsv: (file: File) => void;
}

export const CsvAnalytics: React.FC<CsvAnalyticsProps> = ({
  transactions,
  stats,
  csvFileName,
  strategies,
  onUploadCsv,
}) => {
  const [search, setSearch] = useState('');
  const [filterOutcome, setFilterOutcome] = useState<'all' | 'win' | 'loss'>('all');
  const [replayStrategyId, setReplayStrategyId] = useState<string>(
    strategies.find((s) => s.id === 'reverse-martingale-callput')?.id || strategies[0]?.id || ''
  );
  const [respectThresholds, setRespectThresholds] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const replayStrategy = useMemo(
    () => strategies.find((s) => s.id === replayStrategyId) || strategies[0] || null,
    [replayStrategyId, strategies]
  );

  const replay = useMemo(() => {
    if (!replayStrategy || transactions.length === 0) return null;
    return replayStrategyOnCsv(transactions, replayStrategy, respectThresholds);
  }, [replayStrategy, respectThresholds, transactions]);

  const filteredTx = useMemo(() => {
    return transactions.filter((t) => {
      if (filterOutcome === 'win' && !t.isWin) return false;
      if (filterOutcome === 'loss' && t.isWin) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          t.referenceIdBuy.toLowerCase().includes(q) ||
          t.referenceIdSell.toLowerCase().includes(q) ||
          t.market.toLowerCase().includes(q) ||
          t.startTime.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [filterOutcome, search, transactions]);

  // Equity curve SVG math
  const width = 820;
  const height = 240;
  const padX = 16;
  const padY = 24;

  const chartData = useMemo(() => {
    if (transactions.length === 0) return null;
    const actualVals = [0, ...transactions.map((t) => t.cumulativeProfit)];
    const replayVals = replay ? [0, ...replay.points.map((p) => p.cumulativeProfit)] : actualVals;

    const allVals = [...actualVals, ...replayVals];
    const minV = Math.min(...allVals, -1);
    const maxV = Math.max(...allVals, 1);
    const span = Math.max(maxV - minV, 1);

    const toX = (i: number) => padX + (i / (actualVals.length - 1)) * (width - padX * 2);
    const toY = (v: number) => padY + ((maxV - v) / span) * (height - padY * 2);

    const actualPts = actualVals.map((v, i) => ({ x: toX(i), y: toY(v), v }));
    const replayPts = replayVals.map((v, i) => ({ x: toX(i), y: toY(v), v }));

    const actualD = actualPts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    const replayD = replayPts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

    return {
      minV,
      maxV,
      zeroY: toY(0),
      actualPts,
      replayPts,
      actualD,
      replayD,
    };
  }, [replay, transactions]);

  const handleExportFiltered = () => {
    const header =
      'Market,Reference ID (buy),Reference ID (sell),Barrier,Start Time,Entry Spot,Exit Spot,Buy Price,Profit/Loss,Cumulative P/L';
    const rows = filteredTx.map(
      (t) =>
        `${t.market},${t.referenceIdBuy},${t.referenceIdSell},${t.barrier},${t.startTime},${t.entrySpot},${t.exitSpot},${t.buyPrice.toFixed(2)},${t.profitLoss.toFixed(2)},${t.cumulativeProfit.toFixed(2)}`
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analyzed_${csvFileName}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-[#0E0E0E] dark:text-white">
            Deriv Transactions CSV Analyzer & What-If Replay
          </h1>
          <p className="text-xs font-mono text-[#6E757C] dark:text-[#999999] mt-0.5">
            Source: {csvFileName} · {stats.markets.join(', ') || 'No market loaded'}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportFiltered}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-white dark:bg-[#151717] text-[#333333] dark:text-[#C2C5C7] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          <label className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded transition-colors cursor-pointer whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            Upload Transactions CSV
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadCsv(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 font-mono tabular-nums">
        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Net P/L</div>
          <div
            className={`text-lg font-semibold mt-1 ${
              stats.netProfit >= 0 ? 'text-[#00A79E] dark:text-[#4BB4B3]' : 'text-[#EC3F3F]'
            }`}
          >
            {stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)}
          </div>
        </div>

        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Win Rate</div>
          <div className="text-lg font-semibold text-[#0E0E0E] dark:text-white mt-1">
            {stats.winRate}%
          </div>
          <div className="text-[11px] text-[#6E757C] dark:text-[#999999]">
            {stats.wins}W / {stats.losses}L ({stats.totalTrades})
          </div>
        </div>

        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Profit Factor</div>
          <div className="text-lg font-semibold text-[#0E0E0E] dark:text-white mt-1">
            {stats.profitFactor.toFixed(2)}
          </div>
          <div className="text-[11px] text-[#6E757C] dark:text-[#999999]">
            Expectancy {stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(3)}
          </div>
        </div>

        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Max Drawdown</div>
          <div className="text-lg font-semibold text-[#EC3F3F] mt-1">
            -${Math.abs(stats.maxDrawdown).toFixed(2)}
          </div>
        </div>

        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Streaks</div>
          <div className="text-lg font-semibold text-[#0E0E0E] dark:text-white mt-1">
            <span className="text-[#00A79E] dark:text-[#4BB4B3]">{stats.maxWinStreak}W</span>
            <span className="text-[#6E757C] mx-1">/</span>
            <span className="text-[#EC3F3F]">{stats.maxLossStreak}L</span>
          </div>
        </div>

        <div className="p-3.5 rounded bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30]">
          <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">Total Stake Volume</div>
          <div className="text-lg font-semibold text-[#0E0E0E] dark:text-white mt-1">
            ${stats.totalVolume.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Equity Curve & Strategy Replay Comparator */}
      <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-[#0E0E0E] dark:text-white">
              Cumulative Equity Curve · Actual CSV vs XML Strategy Replay
            </h2>
            <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-0.5">
              Simulates how your selected XML staking engine performs across the exact {transactions.length} market outcomes
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={replayStrategyId}
              onChange={(e) => setReplayStrategyId(e.target.value)}
              className="px-3 py-1.5 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  Replay: {s.name}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-1.5 text-xs text-[#333333] dark:text-[#C2C5C7] cursor-pointer">
              <input
                type="checkbox"
                checked={respectThresholds}
                onChange={(e) => setRespectThresholds(e.target.checked)}
                className="accent-[#FF444F]"
              />
              Stop at XML TP/SL
            </label>
          </div>
        </div>

        {/* Legend & Replay outcome summary */}
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs font-mono tabular-nums">
          <div className="flex items-center gap-5">
            <span className="inline-flex items-center gap-2 text-[#0E0E0E] dark:text-[#F2F3F4]">
              <span className="w-3 h-0.5 bg-[#4BB4B3] inline-block" />
              Actual CSV ({stats.netProfit >= 0 ? '+' : ''}${stats.netProfit.toFixed(2)})
            </span>
            {replay && (
              <span className="inline-flex items-center gap-2 text-[#0E0E0E] dark:text-[#F2F3F4]">
                <span className="w-3 h-0.5 bg-[#FF444F] inline-block" />
                {replayStrategy?.name} ({replay.finalProfit >= 0 ? '+' : ''}$
                {replay.finalProfit.toFixed(2)} · Max DD -${Math.abs(replay.maxDrawdown).toFixed(2)})
              </span>
            )}
          </div>
          {replay?.stopReason && (
            <span className="text-[#D97706] dark:text-[#FFAD3A]">
              Halted at Trade #{replay.stoppedEarlyAt}: {replay.stopReason}
            </span>
          )}
        </div>

        {/* SVG Equity Curve */}
        {chartData && (
          <div className="relative h-[240px] w-full bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30] rounded overflow-hidden">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="w-full h-full block"
              onMouseLeave={() => setHoverIdx(null)}
            >
              {/* Zero baseline */}
              <line
                x1={0}
                y1={chartData.zeroY}
                x2={width}
                y2={chartData.zeroY}
                stroke="#6E757C"
                strokeOpacity={0.45}
                strokeDasharray="4 4"
                strokeWidth={1}
              />

              {/* Actual CSV Path */}
              <path
                d={chartData.actualD}
                fill="none"
                stroke="#4BB4B3"
                strokeWidth={2.2}
                strokeLinejoin="round"
              />

              {/* Replay Path */}
              <path
                d={chartData.replayD}
                fill="none"
                stroke="#FF444F"
                strokeWidth={2}
                strokeDasharray="5 3"
                strokeLinejoin="round"
              />

              {/* Hover vertical guide & dots */}
              {hoverIdx !== null && chartData.actualPts[hoverIdx] && (
                <g>
                  <line
                    x1={chartData.actualPts[hoverIdx].x}
                    y1={0}
                    x2={chartData.actualPts[hoverIdx].x}
                    y2={height}
                    stroke="#999999"
                    strokeDasharray="2 2"
                    strokeWidth={1}
                  />
                  <circle
                    cx={chartData.actualPts[hoverIdx].x}
                    cy={chartData.actualPts[hoverIdx].y}
                    r={4}
                    fill="#4BB4B3"
                  />
                  <circle
                    cx={chartData.replayPts[hoverIdx].x}
                    cy={chartData.replayPts[hoverIdx].y}
                    r={4}
                    fill="#FF444F"
                  />
                </g>
              )}

              {/* Hover capture */}
              {chartData.actualPts.map((pt, i) => (
                <rect
                  key={i}
                  x={Math.max(0, pt.x - width / chartData.actualPts.length / 2)}
                  y={0}
                  width={width / chartData.actualPts.length}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)}
                />
              ))}
            </svg>

            {hoverIdx !== null && hoverIdx > 0 && transactions[hoverIdx - 1] && (
              <div className="pointer-events-none absolute top-2.5 left-3 px-2.5 py-1.5 rounded bg-white/95 dark:bg-[#151717]/95 border border-[#E6E9E9] dark:border-[#2A2E30] text-[11px] font-mono tabular-nums text-[#0E0E0E] dark:text-[#F2F3F4]">
                Trade #{hoverIdx} · {transactions[hoverIdx - 1].startTime.slice(11, 19)} · Actual:{' '}
                {transactions[hoverIdx - 1].cumulativeProfit >= 0 ? '+' : ''}$
                {transactions[hoverIdx - 1].cumulativeProfit.toFixed(2)}
                {replay?.points[hoverIdx - 1] && (
                  <>
                    {' '}
                    · Replay: {replay.points[hoverIdx - 1].cumulativeProfit >= 0 ? '+' : ''}$
                    {replay.points[hoverIdx - 1].cumulativeProfit.toFixed(2)} (Stake $
                    {replay.points[hoverIdx - 1].stake.toFixed(2)})
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transaction Ledger */}
      <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded">
        <div className="p-4 border-b border-[#E6E9E9] dark:border-[#2A2E30] flex flex-wrap items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-[#6E757C] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Reference ID or timestamp..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4] focus:outline-none focus:border-[#FF444F]"
            />
          </div>

          <div className="flex items-center gap-1 p-1 rounded bg-[#F2F3F4] dark:bg-[#0E0E0E]">
            {(['all', 'win', 'loss'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterOutcome(tab)}
                className={`px-3 py-1 text-xs font-medium rounded capitalize transition-colors cursor-pointer ${
                  filterOutcome === tab
                    ? 'bg-white dark:bg-[#1D1F20] text-[#0E0E0E] dark:text-white'
                    : 'text-[#6E757C] dark:text-[#999999]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#6E757C] dark:text-[#999999]">
              <tr className="border-b border-[#E6E9E9] dark:border-[#2A2E30]">
                <th className="text-left font-medium px-4 py-2.5">#</th>
                <th className="text-left font-medium px-3 py-2.5">Start Time (GMT)</th>
                <th className="text-left font-medium px-3 py-2.5">Buy Ref ID</th>
                <th className="text-right font-medium px-3 py-2.5">Entry Spot</th>
                <th className="text-right font-medium px-3 py-2.5">Exit Spot</th>
                <th className="text-right font-medium px-3 py-2.5">Delta</th>
                <th className="text-right font-medium px-3 py-2.5">Stake</th>
                <th className="text-right font-medium px-3 py-2.5">Profit/Loss</th>
                <th className="text-right font-medium px-4 py-2.5">Running Equity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6E9E9] dark:divide-[#222527] font-mono tabular-nums">
              {filteredTx.map((t, idx) => (
                <tr key={t.referenceIdBuy} className="hover:bg-[#F8F9FA] dark:hover:bg-[#1D1F20]">
                  <td className="px-4 py-2.5 text-[#6E757C] dark:text-[#999999]">{idx + 1}</td>
                  <td className="px-3 py-2.5 text-[#0E0E0E] dark:text-[#F2F3F4]">
                    {t.startTime.replace(' GMT', '')}
                  </td>
                  <td className="px-3 py-2.5 text-[#6E757C] dark:text-[#999999]">
                    {t.referenceIdBuy}
                  </td>
                  <td className="px-3 py-2.5 text-right">{t.entrySpot.toFixed(2)}</td>
                  <td className="px-3 py-2.5 text-right">{t.exitSpot.toFixed(2)}</td>
                  <td
                    className={`px-3 py-2.5 text-right ${
                      t.spotDelta >= 0 ? 'text-[#00A79E] dark:text-[#4BB4B3]' : 'text-[#EC3F3F]'
                    }`}
                  >
                    {t.spotDelta >= 0 ? '+' : ''}
                    {t.spotDelta.toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5 text-right">${t.buyPrice.toFixed(2)}</td>
                  <td
                    className={`px-3 py-2.5 text-right font-semibold ${
                      t.isWin ? 'text-[#00A79E] dark:text-[#4BB4B3]' : 'text-[#EC3F3F]'
                    }`}
                  >
                    {t.profitLoss >= 0 ? '+' : ''}${t.profitLoss.toFixed(2)}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right ${
                      t.cumulativeProfit >= 0
                        ? 'text-[#00A79E] dark:text-[#4BB4B3]'
                        : 'text-[#EC3F3F]'
                    }`}
                  >
                    {t.cumulativeProfit >= 0 ? '+' : ''}${t.cumulativeProfit.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
