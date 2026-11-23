import React, { useMemo, useState } from 'react';
import { ActiveContractState } from '../hooks/useBotEngine';
import { ContractCategory, DERIV_SYMBOLS, LiveTick } from '../types/deriv';

interface LiveChartProps {
  ticks: LiveTick[];
  symbol: string;
  category: ContractCategory;
  predictionDigit: number;
  activeContract: ActiveContractState | null;
}

export const LiveChart: React.FC<LiveChartProps> = ({
  ticks,
  symbol,
  category,
  predictionDigit,
  activeContract,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const info = DERIV_SYMBOLS[symbol] || DERIV_SYMBOLS['1HZ100V'];
  const visibleTicks = useMemo(() => ticks.slice(-60), [ticks]);

  // Compute digit frequency from available ticks
  const digitFreq = useMemo(() => {
    const counts = Array(10).fill(0);
    visibleTicks.forEach((t) => {
      if (t.lastDigit >= 0 && t.lastDigit <= 9) {
        counts[t.lastDigit]++;
      }
    });
    const total = visibleTicks.length || 1;
    return counts.map((count, digit) => ({
      digit,
      count,
      pct: Math.round((count / total) * 100),
    }));
  }, [visibleTicks]);

  const width = 760;
  const height = 250;
  const padX = 12;
  const padY = 20;

  const { minPrice, maxPrice, points, pathD, areaD, entryY, highY, lowY } = useMemo(() => {
    if (visibleTicks.length === 0) {
      return {
        minPrice: 0,
        maxPrice: 1,
        points: [],
        pathD: '',
        areaD: '',
        entryY: null,
        highY: null,
        lowY: null,
      };
    }
    const quotes = visibleTicks.map((t) => t.quote);
    if (activeContract?.highBarrier) quotes.push(activeContract.highBarrier);
    if (activeContract?.lowBarrier) quotes.push(activeContract.lowBarrier);
    if (activeContract?.entrySpot) quotes.push(activeContract.entrySpot);

    const rawMin = Math.min(...quotes);
    const rawMax = Math.max(...quotes);
    const span = Math.max(rawMax - rawMin, info.volatilityFactor * 0.5);
    const minP = rawMin - span * 0.12;
    const maxP = rawMax + span * 0.12;

    const toY = (q: number) =>
      padY + ((maxP - q) / (maxP - minP)) * (height - padY * 2);

    const pts = visibleTicks.map((t, idx) => {
      const x =
        visibleTicks.length === 1
          ? width / 2
          : padX + (idx / (visibleTicks.length - 1)) * (width - padX * 2);
      const y = toY(t.quote);
      return { x, y, tick: t };
    });

    const d = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

    const area =
      pts.length > 1
        ? `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${height} L ${pts[0].x.toFixed(1)} ${height} Z`
        : '';

    return {
      minPrice: minP,
      maxPrice: maxP,
      points: pts,
      pathD: d,
      areaD: area,
      entryY: activeContract ? toY(activeContract.entrySpot) : null,
      highY: activeContract?.highBarrier ? toY(activeContract.highBarrier) : null,
      lowY: activeContract?.lowBarrier ? toY(activeContract.lowBarrier) : null,
    };
  }, [activeContract, info.volatilityFactor, visibleTicks]);

  const lastTick = visibleTicks[visibleTicks.length - 1];
  const prevTick = visibleTicks[visibleTicks.length - 2];
  const delta = lastTick && prevTick ? lastTick.quote - prevTick.quote : 0;
  const inspected = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : null;

  return (
    <div className="space-y-4">
      {/* Header readout */}
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-base font-semibold text-[#0E0E0E] dark:text-[#F2F3F4]">
            {info.displayName}
          </h2>
          <span className="text-xs font-mono text-[#6E757C] dark:text-[#999999]">
            {symbol} · {category.toUpperCase()}
          </span>
        </div>

        <div className="flex items-baseline gap-4 font-mono tabular-nums">
          {lastTick ? (
            <>
              <span className="text-2xl font-semibold text-[#0E0E0E] dark:text-white">
                {lastTick.quote.toFixed(info.pipSize)}
              </span>
              <span
                className={`text-xs font-medium ${
                  delta >= 0 ? 'text-[#00A79E] dark:text-[#4BB4B3]' : 'text-[#EC3F3F]'
                }`}
              >
                {delta >= 0 ? '▲' : '▼'} {delta >= 0 ? '+' : ''}
                {delta.toFixed(info.pipSize)}
              </span>
              <span className="text-xs text-[#6E757C] dark:text-[#999999]">
                Last Digit:{' '}
                <strong className="text-[#FF444F] font-semibold">{lastTick.lastDigit}</strong>
              </span>
            </>
          ) : (
            <span className="text-sm text-[#6E757C] dark:text-[#999999]">
              Waiting for tick stream...
            </span>
          )}
        </div>
      </div>

      {/* SVG Tick Canvas */}
      <div className="relative w-full h-[250px] bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30] rounded overflow-hidden">
        {visibleTicks.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-[#6E757C] dark:text-[#999999]">
            Connecting to Deriv market feed...
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="w-full h-full block"
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id="derivTickGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4BB4B3" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#4BB4B3" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Horizontal grid lines */}
            {[0.25, 0.5, 0.75].map((ratio) => (
              <line
                key={ratio}
                x1={0}
                y1={height * ratio}
                x2={width}
                y2={height * ratio}
                stroke="currentColor"
                className="text-[#E6E9E9] dark:text-[#222527]"
                strokeDasharray="3 4"
                strokeWidth={1}
              />
            ))}

            {/* Accumulator Barrier Corridor */}
            {highY !== null && lowY !== null && (
              <g>
                <rect
                  x={0}
                  y={Math.min(highY, lowY)}
                  width={width}
                  height={Math.max(2, Math.abs(lowY - highY))}
                  fill="#4BB4B3"
                  fillOpacity={0.08}
                />
                <line
                  x1={0}
                  y1={highY}
                  x2={width}
                  y2={highY}
                  stroke="#FFAD3A"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                />
                <line
                  x1={0}
                  y1={lowY}
                  x2={width}
                  y2={lowY}
                  stroke="#FFAD3A"
                  strokeDasharray="4 3"
                  strokeWidth={1}
                />
              </g>
            )}

            {/* Entry spot reference line */}
            {entryY !== null && (
              <line
                x1={0}
                y1={entryY}
                x2={width}
                y2={entryY}
                stroke="#FF444F"
                strokeDasharray="5 3"
                strokeWidth={1.2}
              />
            )}

            {/* Area + Line */}
            {areaD && <path d={areaD} fill="url(#derivTickGrad)" />}
            {pathD && (
              <path
                d={pathD}
                fill="none"
                stroke="#4BB4B3"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/* Last tick marker */}
            {points.length > 0 && (
              <circle
                cx={points[points.length - 1].x}
                cy={points[points.length - 1].y}
                r={4}
                fill="#FF444F"
              />
            )}

            {/* Hover vertical guide */}
            {inspected && (
              <g>
                <line
                  x1={inspected.x}
                  y1={0}
                  x2={inspected.x}
                  y2={height}
                  stroke="#999999"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                <circle cx={inspected.x} cy={inspected.y} r={4} fill="#FFFFFF" stroke="#FF444F" strokeWidth={2} />
              </g>
            )}

            {/* Invisible hover capture columns */}
            {points.map((p, idx) => (
              <rect
                key={idx}
                x={Math.max(0, p.x - width / visibleTicks.length / 2)}
                y={0}
                width={width / visibleTicks.length}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            ))}
          </svg>
        )}

        {/* Price bounds & hover readout */}
        <div className="pointer-events-none absolute top-2 right-3 text-[11px] font-mono tabular-nums text-[#6E757C] dark:text-[#999999]">
          High {maxPrice.toFixed(info.pipSize)} · Low {minPrice.toFixed(info.pipSize)}
        </div>
        {inspected && (
          <div className="pointer-events-none absolute top-2 left-3 px-2 py-1 rounded bg-white/95 dark:bg-[#151717]/95 border border-[#E6E9E9] dark:border-[#2A2E30] text-[11px] font-mono tabular-nums text-[#0E0E0E] dark:text-[#F2F3F4]">
            {new Date(inspected.tick.epoch * 1000).toISOString().slice(11, 19)} · Spot{' '}
            {inspected.tick.quote.toFixed(info.pipSize)} · Digit {inspected.tick.lastDigit}
          </div>
        )}
      </div>

      {/* Digit Frequency Strip (especially actionable for DigitScalper) */}
      <div className="pt-1">
        <div className="flex items-center justify-between text-xs text-[#6E757C] dark:text-[#999999] mb-2">
          <span>Last {visibleTicks.length} Ticks Digit Distribution (0–9)</span>
          {category === 'digits' && (
            <span className="font-mono tabular-nums">
              Target Prediction: <strong className="text-[#FF444F]">{predictionDigit}</strong>
            </span>
          )}
        </div>
        <div className="grid grid-cols-10 gap-1.5">
          {digitFreq.map((item) => {
            const isTarget = category === 'digits' && item.digit === predictionDigit;
            const isLatest = lastTick?.lastDigit === item.digit;
            return (
              <div
                key={item.digit}
                className={`p-2 rounded border text-center font-mono tabular-nums transition-colors ${
                  isTarget
                    ? 'border-[#FF444F] bg-[#FF444F]/10'
                    : isLatest
                      ? 'border-[#4BB4B3] bg-[#4BB4B3]/10'
                      : 'border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]'
                }`}
              >
                <div
                  className={`text-xs font-semibold ${
                    isTarget
                      ? 'text-[#FF444F]'
                      : isLatest
                        ? 'text-[#00A79E] dark:text-[#4BB4B3]'
                        : 'text-[#0E0E0E] dark:text-[#F2F3F4]'
                  }`}
                >
                  {item.digit}
                </div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] mt-0.5">
                  {item.pct}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
