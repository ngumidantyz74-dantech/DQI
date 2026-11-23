import React, { useMemo, useState } from 'react';
import { Download, Play, RotateCcw, Square, Upload } from 'lucide-react';
import { BotSessionState } from '../hooks/useBotEngine';
import {
  BotJournalEntry,
  BotStrategyConfig,
  DERIV_SYMBOLS,
  ExecutedTrade,
  LiveTick,
  PurchaseDirection,
} from '../types/deriv';
import { serializeConfigToXml } from '../utils/xmlParser';
import { LiveChart } from './LiveChart';

interface StrategyRunnerProps {
  strategies: BotStrategyConfig[];
  selectedId: string;
  onSelectStrategy: (id: string) => void;
  onUpdateStrategy: (updated: BotStrategyConfig) => void;
  onUploadXml: (file: File) => void;
  ticks: LiveTick[];
  session: BotSessionState;
  trades: ExecutedTrade[];
  journal: BotJournalEntry[];
  onStart: () => void;
  onStop: () => void;
  onSellAtMarket: () => void;
  onResetSession: () => void;
}

export const StrategyRunner: React.FC<StrategyRunnerProps> = ({
  strategies,
  selectedId,
  onSelectStrategy,
  onUpdateStrategy,
  onUploadXml,
  ticks,
  session,
  trades,
  journal,
  onStart,
  onStop,
  onSellAtMarket,
  onResetSession,
}) => {
  const [bottomTab, setBottomTab] = useState<'trades' | 'journal'>('trades');

  const strategy = useMemo(
    () => strategies.find((s) => s.id === selectedId) || strategies[0] || null,
    [selectedId, strategies]
  );

  // Compute upcoming stake progression preview (5 steps)
  const stakeLadder = useMemo(() => {
    if (!strategy) return [];
    const rows: { step: number; onWin: number; onLoss: number }[] = [];
    let winMult = 1;
    let winStreak = 0;
    let winUnits = 1;
    let lossUnits = 1;

    for (let i = 1; i <= 5; i++) {
      let winStake = strategy.initialStake;
      let lossStake = strategy.initialStake;

      if (strategy.engineType === 'digit_scalper') {
        winStake = strategy.initialStake + winStreak * strategy.winStep;
        winStreak = winStreak + 1 > strategy.maxWinSteps ? 0 : winStreak + 1;
        lossStake = strategy.initialStake;
      } else if (strategy.engineType === 'reverse_martingale') {
        winStake = strategy.initialStake * winMult;
        winMult = winMult * strategy.multiplierSize;
        if (strategy.useMaxStake && strategy.initialStake * winMult > strategy.maxStake) {
          winMult = 1;
        }
        lossStake = strategy.initialStake;
      } else if (strategy.engineType === 'dalembert') {
        winStake = strategy.initialStake * winUnits;
        winUnits = Math.max(1, winUnits - strategy.changeInUnit);

        lossStake = strategy.initialStake * lossUnits;
        lossUnits = lossUnits + strategy.changeInUnit;
        if (strategy.useMaxStake && strategy.initialStake * lossUnits > strategy.maxStake) {
          lossUnits = 1;
        }
      }

      if (strategy.useMaxStake && winStake > strategy.maxStake) winStake = strategy.initialStake;
      if (strategy.useMaxStake && lossStake > strategy.maxStake) lossStake = strategy.initialStake;

      rows.push({
        step: i,
        onWin: Number(winStake.toFixed(2)),
        onLoss: Number(lossStake.toFixed(2)),
      });
    }
    return rows;
  }, [strategy]);

  if (!strategy) {
    return (
      <div className="p-8 text-center text-sm text-[#6E757C] dark:text-[#999999]">
        Loading strategy configurations...
      </div>
    );
  }

  const updateField = <K extends keyof BotStrategyConfig>(key: K, value: BotStrategyConfig[K]) => {
    onUpdateStrategy({
      ...strategy,
      [key]: value,
    });
  };

  const handleExportXml = () => {
    const xml = serializeConfigToXml(strategy);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = strategy.fileName || `${strategy.id}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const winRate =
    session.tradesCount > 0 ? ((session.wins / session.tradesCount) * 100).toFixed(1) : '0.0';

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
      {/* LEFT PANEL: Strategy Picker & Parameters */}
      <aside className="xl:col-span-3 bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-4 space-y-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[#0E0E0E] dark:text-[#F2F3F4]">
            Strategy Configuration
          </h2>
          <label className="inline-flex items-center gap-1.5 text-xs font-medium text-[#FF444F] hover:text-[#EB3E48] cursor-pointer whitespace-nowrap">
            <Upload className="w-3.5 h-3.5" />
            Import XML
            <input
              type="file"
              accept=".xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadXml(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
        </div>

        {/* Strategy Selector Buttons */}
        <div className="space-y-1.5">
          {strategies.map((s) => {
            const active = s.id === strategy.id;
            return (
              <button
                key={s.id}
                type="button"
                disabled={session.isRunning}
                onClick={() => onSelectStrategy(s.id)}
                className={`w-full text-left px-3 py-2.5 rounded border transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                  active
                    ? 'border-[#FF444F] bg-[#FF444F]/10 text-[#0E0E0E] dark:text-white'
                    : 'border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#333333] dark:text-[#C2C5C7] hover:border-[#999999]'
                }`}
              >
                <div className="text-xs font-semibold truncate">{s.name}</div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] mt-0.5 font-mono truncate">
                  {s.symbol} · {s.purchaseType} · ${s.initialStake}
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-t border-[#E6E9E9] dark:border-[#2A2E30] pt-4 space-y-3">
          {/* Market Symbol */}
          <div>
            <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
              Synthetic Index
            </label>
            <select
              disabled={session.isRunning}
              value={strategy.symbol}
              onChange={(e) => updateField('symbol', e.target.value)}
              className="w-full px-3 py-2 text-xs font-medium rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4] focus:outline-none focus:border-[#FF444F]"
            >
              {Object.values(DERIV_SYMBOLS).map((sym) => (
                <option key={sym.symbol} value={sym.symbol}>
                  {sym.displayName} ({sym.symbol})
                </option>
              ))}
            </select>
          </div>

          {/* Contract Direction / Type */}
          {strategy.tradeTypeCategory === 'digits' && (
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Contract
                </label>
                <select
                  disabled={session.isRunning}
                  value={strategy.purchaseType}
                  onChange={(e) => updateField('purchaseType', e.target.value as PurchaseDirection)}
                  className="w-full px-2.5 py-2 text-xs font-mono rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                >
                  <option value="DIGITMATCH">DIGITMATCH</option>
                  <option value="DIGITDIFF">DIGITDIFF</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Prediction (0–9)
                </label>
                <input
                  type="number"
                  min={0}
                  max={9}
                  disabled={session.isRunning}
                  value={strategy.prediction}
                  onChange={(e) =>
                    updateField('prediction', Math.min(9, Math.max(0, Number(e.target.value) || 0)))
                  }
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                />
              </div>
            </div>
          )}

          {strategy.tradeTypeCategory === 'callput' && (
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Direction
                </label>
                <select
                  disabled={session.isRunning}
                  value={strategy.purchaseType}
                  onChange={(e) => updateField('purchaseType', e.target.value as PurchaseDirection)}
                  className="w-full px-2.5 py-2 text-xs font-mono rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                >
                  <option value="CALL">Rise (CALL)</option>
                  <option value="PUT">Fall (PUT)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Ticks Duration
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  disabled={session.isRunning}
                  value={strategy.duration}
                  onChange={(e) => updateField('duration', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                />
              </div>
            </div>
          )}

          {strategy.tradeTypeCategory === 'accumulator' && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                    Growth Rate
                  </label>
                  <select
                    disabled={session.isRunning}
                    value={strategy.growthRate}
                    onChange={(e) => updateField('growthRate', Number(e.target.value))}
                    className="w-full px-2.5 py-2 text-xs font-mono rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                  >
                    <option value={0.01}>1%</option>
                    <option value={0.02}>2%</option>
                    <option value={0.03}>3%</option>
                    <option value={0.04}>4%</option>
                    <option value={0.05}>5%</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                    Auto TP ($)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    disabled={session.isRunning}
                    value={strategy.takeProfit}
                    onChange={(e) => updateField('takeProfit', Math.max(0.5, Number(e.target.value) || 1))}
                    className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-xs pt-1">
                <label className="flex items-center gap-2 text-[#333333] dark:text-[#C2C5C7] cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={session.isRunning}
                    checked={strategy.takeProfitEnabled}
                    onChange={(e) => updateField('takeProfitEnabled', e.target.checked)}
                    className="accent-[#FF444F]"
                  />
                  Enable Accumulator TP
                </label>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs">
                <label className="flex items-center gap-2 text-[#333333] dark:text-[#C2C5C7] cursor-pointer">
                  <input
                    type="checkbox"
                    disabled={session.isRunning}
                    checked={strategy.sellByCountdown}
                    onChange={(e) => updateField('sellByCountdown', e.target.checked)}
                    className="accent-[#FF444F]"
                  />
                  Sell by Tick Count
                </label>
                {strategy.sellByCountdown && (
                  <input
                    type="number"
                    min={1}
                    max={50}
                    disabled={session.isRunning}
                    value={strategy.tickCount}
                    onChange={(e) => updateField('tickCount', Math.max(1, Number(e.target.value) || 1))}
                    className="w-16 px-2 py-1 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]"
                  />
                )}
              </div>
            </div>
          )}

          {/* Core Money Management */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                Stake ($)
              </label>
              <input
                type="number"
                step="0.5"
                min={0.35}
                disabled={session.isRunning}
                value={strategy.initialStake}
                onChange={(e) => updateField('initialStake', Math.max(0.35, Number(e.target.value) || 0.35))}
                className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                Target ($)
              </label>
              <input
                type="number"
                step="1"
                min={0.5}
                disabled={session.isRunning}
                value={strategy.profitThreshold}
                onChange={(e) => updateField('profitThreshold', Math.max(0.5, Number(e.target.value) || 1))}
                className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                Stop Loss ($)
              </label>
              <input
                type="number"
                step="1"
                min={0.5}
                disabled={session.isRunning}
                value={strategy.lossThreshold}
                onChange={(e) => updateField('lossThreshold', Math.max(0.5, Number(e.target.value) || 1))}
                className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]"
              />
            </div>
          </div>

          {/* Engine-Specific Parameters */}
          {strategy.engineType === 'digit_scalper' && (
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Win Step (+$)
                </label>
                <input
                  type="number"
                  step="0.25"
                  min={0}
                  disabled={session.isRunning}
                  value={strategy.winStep}
                  onChange={(e) => updateField('winStep', Math.max(0, Number(e.target.value) || 0))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Max Win Steps
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  disabled={session.isRunning}
                  value={strategy.maxWinSteps}
                  onChange={(e) => updateField('maxWinSteps', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]"
                />
              </div>
            </div>
          )}

          {strategy.engineType === 'reverse_martingale' && (
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Win Multiplier
                </label>
                <input
                  type="number"
                  step="0.5"
                  min={1}
                  disabled={session.isRunning}
                  value={strategy.multiplierSize}
                  onChange={(e) => updateField('multiplierSize', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Max Stake ($)
                </label>
                <input
                  type="number"
                  step="1"
                  min={1}
                  disabled={session.isRunning || !strategy.useMaxStake}
                  value={strategy.maxStake}
                  onChange={(e) => updateField('maxStake', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] disabled:opacity-50"
                />
              </div>
            </div>
          )}

          {strategy.engineType === 'dalembert' && (
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Unit Step
                </label>
                <input
                  type="number"
                  step="1"
                  min={1}
                  disabled={session.isRunning}
                  value={strategy.changeInUnit}
                  onChange={(e) => updateField('changeInUnit', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E]"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-[#6E757C] dark:text-[#999999] mb-1">
                  Max Stake ($)
                </label>
                <input
                  type="number"
                  step="1"
                  min={1}
                  disabled={session.isRunning || !strategy.useMaxStake}
                  value={strategy.maxStake}
                  onChange={(e) => updateField('maxStake', Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-2 text-xs font-mono tabular-nums rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] disabled:opacity-50"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 text-xs text-[#333333] dark:text-[#C2C5C7] cursor-pointer">
              <input
                type="checkbox"
                disabled={session.isRunning}
                checked={strategy.useMaxStake}
                onChange={(e) => updateField('useMaxStake', e.target.checked)}
                className="accent-[#FF444F]"
              />
              Enforce Max Stake Cap
            </label>

            <button
              type="button"
              onClick={handleExportXml}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6E757C] dark:text-[#999999] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export XML
            </button>
          </div>
        </div>
      </aside>

      {/* CENTER PANEL: Live Tick Chart, Execution Controls, Open Position & Trades Ledger */}
      <section className="xl:col-span-6 space-y-5">
        <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-5 space-y-5">
          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[#E6E9E9] dark:border-[#2A2E30]">
            <div>
              <h1 className="text-base font-semibold text-[#0E0E0E] dark:text-white">
                {strategy.name}
              </h1>
              <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-0.5">
                {strategy.fileName} · {strategy.engineType.replace('_', ' ')}
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              {session.activeContract && strategy.tradeTypeCategory === 'accumulator' && (
                <button
                  type="button"
                  onClick={onSellAtMarket}
                  className="px-3.5 py-2 text-xs font-semibold rounded border border-[#4BB4B3] text-[#00A79E] dark:text-[#4BB4B3] hover:bg-[#4BB4B3]/10 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Sell at Market ({session.activeContract.currentProfit >= 0 ? '+' : ''}$
                  {session.activeContract.currentProfit.toFixed(2)})
                </button>
              )}

              <button
                type="button"
                onClick={onResetSession}
                disabled={session.isRunning}
                title="Reset session log"
                className="p-2 rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#6E757C] dark:text-[#999999] hover:text-[#0E0E0E] dark:hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              {session.isRunning ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-[#2A2E30] hover:bg-[#3A3F42] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  Stop Bot
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStart}
                  className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-[#FF444F] hover:bg-[#EB3E48] rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  Run Bot
                </button>
              )}
            </div>
          </div>

          {/* Live Tick Chart */}
          <LiveChart
            ticks={ticks}
            symbol={strategy.symbol}
            category={strategy.tradeTypeCategory}
            predictionDigit={strategy.prediction}
            activeContract={session.activeContract}
          />

          {/* Open Position Strip */}
          {session.activeContract && (
            <div className="p-3.5 rounded border border-[#4BB4B3]/40 bg-[#4BB4B3]/5 grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono tabular-nums text-xs">
              <div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] font-sans">
                  Contract ID
                </div>
                <div className="font-semibold text-[#0E0E0E] dark:text-white mt-0.5 truncate">
                  {session.activeContract.contractId}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] font-sans">
                  Entry Spot
                </div>
                <div className="font-semibold text-[#0E0E0E] dark:text-white mt-0.5">
                  {session.activeContract.entrySpot.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] font-sans">
                  Stake
                </div>
                <div className="font-semibold text-[#0E0E0E] dark:text-white mt-0.5">
                  ${session.activeContract.stake.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] font-sans">
                  Ticks Held
                </div>
                <div className="font-semibold text-[#0E0E0E] dark:text-white mt-0.5">
                  {session.activeContract.ticksHeld}
                  {strategy.tradeTypeCategory !== 'accumulator' ? ` / ${strategy.duration}` : ''}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[#6E757C] dark:text-[#999999] font-sans">
                  Open P/L
                </div>
                <div
                  className={`font-semibold mt-0.5 ${
                    session.activeContract.currentProfit >= 0
                      ? 'text-[#00A79E] dark:text-[#4BB4B3]'
                      : 'text-[#EC3F3F]'
                  }`}
                >
                  {session.activeContract.currentProfit >= 0 ? '+' : ''}$
                  {session.activeContract.currentProfit.toFixed(2)}
                </div>
              </div>
            </div>
          )}

          {session.stopReason && !session.isRunning && (
            <div className="px-3.5 py-2.5 rounded border border-[#E6E9E9] dark:border-[#2A2E30] bg-[#F8F9FA] dark:bg-[#0E0E0E] text-xs text-[#333333] dark:text-[#C2C5C7]">
              Session halted: <strong className="text-[#0E0E0E] dark:text-white">{session.stopReason}</strong>
            </div>
          )}
        </div>

        {/* Trades Ledger / Journal */}
        <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded">
          <div className="flex items-center justify-between px-4 border-b border-[#E6E9E9] dark:border-[#2A2E30]">
            <div className="flex items-center gap-6">
              <button
                type="button"
                onClick={() => setBottomTab('trades')}
                className={`py-3 text-xs font-semibold relative cursor-pointer ${
                  bottomTab === 'trades'
                    ? 'text-[#0E0E0E] dark:text-white'
                    : 'text-[#6E757C] dark:text-[#999999]'
                }`}
              >
                Transactions ({trades.length})
                {bottomTab === 'trades' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF444F]" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setBottomTab('journal')}
                className={`py-3 text-xs font-semibold relative cursor-pointer ${
                  bottomTab === 'journal'
                    ? 'text-[#0E0E0E] dark:text-white'
                    : 'text-[#6E757C] dark:text-[#999999]'
                }`}
              >
                Execution Journal ({journal.length})
                {bottomTab === 'journal' && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF444F]" />
                )}
              </button>
            </div>
          </div>

          {bottomTab === 'trades' ? (
            <div className="overflow-x-auto max-h-72">
              {trades.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#6E757C] dark:text-[#999999]">
                  No trades executed in this session yet. Click <strong>Run Bot</strong> to begin executing on live ticks.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-[#F8F9FA] dark:bg-[#0E0E0E] text-[#6E757C] dark:text-[#999999] sticky top-0">
                    <tr className="border-b border-[#E6E9E9] dark:border-[#2A2E30]">
                      <th className="text-left font-medium px-4 py-2.5">Ref / Time</th>
                      <th className="text-left font-medium px-3 py-2.5">Contract</th>
                      <th className="text-right font-medium px-3 py-2.5">Entry</th>
                      <th className="text-right font-medium px-3 py-2.5">Exit</th>
                      <th className="text-right font-medium px-3 py-2.5">Buy</th>
                      <th className="text-right font-medium px-4 py-2.5">Profit/Loss</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6E9E9] dark:divide-[#222527] font-mono tabular-nums">
                    {trades.map((t) => (
                      <tr key={t.id} className="hover:bg-[#F8F9FA] dark:hover:bg-[#1D1F20]">
                        <td className="px-4 py-2.5 text-[#333333] dark:text-[#C2C5C7]">
                          <div>{t.contractId}</div>
                          <div className="text-[11px] text-[#6E757C] dark:text-[#999999]">
                            {t.timestamp.slice(11, 19)}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-sans text-[#0E0E0E] dark:text-[#F2F3F4]">
                          {t.contractType} · {t.symbol}
                          {t.exitDigit !== undefined && (
                            <span className="text-[#6E757C] dark:text-[#999999] ml-1">
                              (d:{t.exitDigit})
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">{t.entrySpot.toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right">{t.exitSpot.toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-right">${t.buyPrice.toFixed(2)}</td>
                        <td
                          className={`px-4 py-2.5 text-right font-semibold ${
                            t.isWin ? 'text-[#00A79E] dark:text-[#4BB4B3]' : 'text-[#EC3F3F]'
                          }`}
                        >
                          {t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto divide-y divide-[#E6E9E9] dark:divide-[#222527]">
              {journal.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#6E757C] dark:text-[#999999]">
                  Bot notifications (`notify` blocks) and threshold checks appear here in real time.
                </div>
              ) : (
                journal.map((entry) => (
                  <div key={entry.id} className="px-4 py-2.5 flex items-baseline gap-3 text-xs">
                    <span className="font-mono tabular-nums text-[11px] text-[#6E757C] dark:text-[#999999] shrink-0">
                      {entry.time}
                    </span>
                    <span
                      className={`font-semibold uppercase text-[10px] w-12 shrink-0 ${
                        entry.type === 'success'
                          ? 'text-[#00A79E] dark:text-[#4BB4B3]'
                          : entry.type === 'error'
                            ? 'text-[#EC3F3F]'
                            : entry.type === 'warn'
                              ? 'text-[#D97706] dark:text-[#FFAD3A]'
                              : 'text-[#6E757C] dark:text-[#999999]'
                      }`}
                    >
                      {entry.type}
                    </span>
                    <span className="text-[#0E0E0E] dark:text-[#F2F3F4]">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      {/* RIGHT PANEL: Session Telemetry & Stake Progression Ladder */}
      <aside className="xl:col-span-3 space-y-5">
        <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[#0E0E0E] dark:text-[#F2F3F4]">
            Session Telemetry
          </h2>

          <div className="grid grid-cols-2 gap-3 font-mono tabular-nums">
            <div className="p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
              <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">
                Total Profit
              </div>
              <div
                className={`text-lg font-semibold mt-0.5 ${
                  session.totalProfit >= 0
                    ? 'text-[#00A79E] dark:text-[#4BB4B3]'
                    : 'text-[#EC3F3F]'
                }`}
              >
                {session.totalProfit >= 0 ? '+' : ''}${session.totalProfit.toFixed(2)}
              </div>
            </div>

            <div className="p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
              <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">
                Next Stake
              </div>
              <div className="text-lg font-semibold text-[#0E0E0E] dark:text-white mt-0.5">
                ${session.currentStake.toFixed(2)}
              </div>
            </div>

            <div className="p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
              <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">
                Win Rate
              </div>
              <div className="text-base font-semibold text-[#0E0E0E] dark:text-white mt-0.5">
                {winRate}%
              </div>
            </div>

            <div className="p-3 rounded bg-[#F8F9FA] dark:bg-[#0E0E0E] border border-[#E6E9E9] dark:border-[#2A2E30]">
              <div className="text-[11px] font-sans text-[#6E757C] dark:text-[#999999]">
                Won / Lost
              </div>
              <div className="text-base font-semibold mt-0.5">
                <span className="text-[#00A79E] dark:text-[#4BB4B3]">{session.wins}</span>
                <span className="text-[#6E757C] mx-1">/</span>
                <span className="text-[#EC3F3F]">{session.losses}</span>
              </div>
            </div>
          </div>

          {/* Target Progress Bar */}
          <div className="space-y-1.5 pt-1">
            <div className="flex justify-between text-[11px] font-mono tabular-nums text-[#6E757C] dark:text-[#999999]">
              <span>SL -${strategy.lossThreshold.toFixed(2)}</span>
              <span>TP +${strategy.profitThreshold.toFixed(2)}</span>
            </div>
            <div className="h-2 w-full bg-[#F2F3F4] dark:bg-[#0E0E0E] rounded overflow-hidden flex">
              <div
                className="h-full bg-[#EC3F3F] transition-all duration-150"
                style={{
                  width: `${
                    session.totalProfit < 0
                      ? Math.min(100, (Math.abs(session.totalProfit) / strategy.lossThreshold) * 50)
                      : 0
                  }%`,
                }}
              />
              <div
                className="h-full bg-[#4BB4B3] transition-all duration-150 ml-auto"
                style={{
                  width: `${
                    session.totalProfit > 0
                      ? Math.min(100, (session.totalProfit / strategy.profitThreshold) * 50)
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        </div>

        {/* Stake Progression Ladder */}
        <div className="bg-white dark:bg-[#151717] border border-[#E6E9E9] dark:border-[#2A2E30] rounded p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[#0E0E0E] dark:text-[#F2F3F4]">
              Stake Progression Ladder
            </h2>
            <p className="text-xs text-[#6E757C] dark:text-[#999999] mt-0.5">
              5-step projection for {strategy.engineType.replace('_', ' ')}
            </p>
          </div>

          <table className="w-full text-xs font-mono tabular-nums">
            <thead>
              <tr className="border-b border-[#E6E9E9] dark:border-[#2A2E30] text-[#6E757C] dark:text-[#999999]">
                <th className="text-left font-sans font-medium py-1.5">Step</th>
                <th className="text-right font-sans font-medium py-1.5">Win Streak</th>
                <th className="text-right font-sans font-medium py-1.5">Loss Streak</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6E9E9] dark:divide-[#222527]">
              {stakeLadder.map((row) => (
                <tr key={row.step}>
                  <td className="py-2 text-[#6E757C] dark:text-[#999999]">#{row.step}</td>
                  <td className="py-2 text-right text-[#00A79E] dark:text-[#4BB4B3]">
                    ${row.onWin.toFixed(2)}
                  </td>
                  <td className="py-2 text-right text-[#EC3F3F]">${row.onLoss.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
};
