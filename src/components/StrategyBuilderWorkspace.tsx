import React, { useEffect, useState } from 'react';
import {
  FileSpreadsheet,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  Upload,
} from 'lucide-react';
import { dqiApi } from '../services/dqiApi';
import type { ActiveSymbol, PaperStrategy } from '../types/dqi';
import type { BotStrategyConfig, CsvSummaryStats, CsvTransaction } from '../types/deriv';
import { loadPreloadedCsv, loadPreloadedStrategies } from '../utils/preloadedAssets';
import { parseDbotXml } from '../utils/xmlParser';
import { parseDerivCsv, replayStrategyOnCsv } from '../utils/csvParser';

interface StrategyBuilderWorkspaceProps {
  symbols: ActiveSymbol[];
  selectedSymbol: string;
}

export const StrategyBuilderWorkspace: React.FC<StrategyBuilderWorkspaceProps> = ({
  symbols,
  selectedSymbol,
}) => {
  // Visual Bot Builder blocks (Deriv Bot Builder palette: #FFFFFF/#F1F2F4 canvas, #203DA8 blue block headers, #20B7C6 turquoise controls, #F74355 actions)
  const [botName, setBotName] = useState('DQI Trend & Digit Guard v1');
  const [blockSymbol, setBlockSymbol] = useState(selectedSymbol || 'R_100');
  const [blockTimeframe, setBlockTimeframe] = useState('M5');
  const [blockFamily, setBlockFamily] = useState<'CALL_PUT' | 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITEVEN_ODD'>('CALL_PUT');
  const [blockRiskPct, setBlockRiskPct] = useState('0.5');
  const [blockExpirySec, setBlockExpirySec] = useState('300');
  const [blockPayout, setBlockPayout] = useState('0.85');
  const [blockMinConf, setBlockMinConf] = useState('0.65');
  const [blockCooldown, setBlockCooldown] = useState('300');
  const [autoEnableOnCreate, setAutoEnableOnCreate] = useState(false);

  const [savedStrategies, setSavedStrategies] = useState<PaperStrategy[]>([]);
  const [automation, setAutomation] = useState<{
    control: { enabled: boolean; kill_switch: boolean; paused_reason: string | null };
    active_strategies: number;
    alerts: Array<{ alert_id: number; severity: string; alert_code: string; message: string; acknowledged_at: string | null }>;
  } | null>(null);

  // Preloaded DBot XMLs & CSV replay integration
  const [xmlStrategies, setXmlStrategies] = useState<BotStrategyConfig[]>([]);
  const [selectedXml, setSelectedXml] = useState<BotStrategyConfig | null>(null);
  const [csvStats, setCsvStats] = useState<CsvSummaryStats | null>(null);
  const [csvTx, setCsvTx] = useState<CsvTransaction[]>([]);
  const [replaySummary, setReplaySummary] = useState<{ finalProfit: number; maxDrawdown: number; stopReason: string | null } | null>(null);

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  async function refreshWorkspace() {
    try {
      const [strats, auto] = await Promise.all([dqiApi.getStrategies(), dqiApi.getAutomationStatus()]);
      setSavedStrategies(strats.strategies || []);
      setAutomation(auto);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshWorkspace();
    loadPreloadedStrategies()
      .then((list) => {
        setXmlStrategies(list);
        if (list.length > 0) setSelectedXml(list[0]);
      })
      .catch(() => undefined);

    loadPreloadedCsv()
      .then((text) => {
        const parsed = parseDerivCsv(text);
        setCsvTx(parsed.transactions);
        setCsvStats(parsed.stats);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (selectedXml && csvTx.length > 0) {
      const rep = replayStrategyOnCsv(csvTx, selectedXml, true);
      setReplaySummary({
        finalProfit: rep.finalProfit,
        maxDrawdown: rep.maxDrawdown,
        stopReason: rep.stopReason,
      });
    }
  }, [selectedXml, csvTx]);

  async function handleSaveBlockStrategy() {
    setBusy(true);
    setStatusMsg(null);
    try {
      await dqiApi.createStrategy({
        name: botName,
        description: `Visual block strategy (${blockFamily}) on ${blockSymbol}`,
        symbol: blockSymbol,
        timeframe: blockTimeframe,
        contract_family: blockFamily,
        parameters: { model: 'dqi_signal_v1' },
        blocks: {
          tradeDefinition: { symbol: blockSymbol, family: blockFamily, timeframe: blockTimeframe },
          riskGuard: { riskFraction: Number(blockRiskPct) / 100, cooldownSec: Number(blockCooldown) },
        },
        enabled: true,
        auto_enabled: autoEnableOnCreate,
        risk_fraction: Math.min(0.02, Math.max(0.001, (Number(blockRiskPct) || 0.5) / 100)),
        expiry_seconds: Math.max(10, Number(blockExpirySec) || 300),
        payout_multiplier: Number(blockPayout) || 0.85,
        min_confidence: Number(blockMinConf) || 0.65,
        cooldown_seconds: Math.max(10, Number(blockCooldown) || 300),
      });
      setStatusMsg('Strategy block graph validated and saved to Paper Lab.');
      await refreshWorkspace();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Unable to save strategy');
    } finally {
      setBusy(false);
    }
  }

  function handleLoadXmlIntoBuilder(bot: BotStrategyConfig) {
    setSelectedXml(bot);
    setBotName(bot.name);
    setBlockSymbol(bot.symbol);
    setBlockFamily(
      bot.tradeTypeCategory === 'digits'
        ? bot.purchaseType === 'DIGITMATCH'
          ? 'DIGITMATCH'
          : 'DIGITDIFF'
        : 'CALL_PUT'
    );
    setBlockCooldown('60');
    setStatusMsg(`Loaded ${bot.name} parameters into Block Builder.`);
  }

  async function handleUploadXml(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseDbotXml(text, {
      id: `upload-${Date.now()}`,
      name: file.name.replace(/\.xml$/i, ''),
      fileName: file.name,
    });
    setXmlStrategies((prev) => [parsed, ...prev]);
    handleLoadXmlIntoBuilder(parsed);
  }

  return (
    <div className="space-y-4">
      {/* BOT BUILDER BLOCK WORKSPACE (TraderScheme / Deriv Bot Builder Visual Language) */}
      <div className="bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-[#101820] text-white flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Visual Strategy Block Builder (Paper Mode Only)</h2>
            <p className="text-xs text-[#9CA3AF]">
              Build, save, and evaluate automated paper rules — isolated from live money accounts
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="px-3 py-1.5 text-xs font-medium rounded bg-[#20B7C6] hover:bg-[#1AA1AF] text-[#101820] cursor-pointer flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" />
              Import DBot .xml
              <input type="file" accept=".xml" onChange={handleUploadXml} className="hidden" />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={handleSaveBlockStrategy}
              className="px-4 py-1.5 text-xs font-semibold rounded bg-[#F74355] hover:bg-[#DF3446] text-white flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Save Strategy
            </button>
          </div>
        </div>

        <div className="p-4 bg-[#F1F2F4] dark:bg-[#0E0E0E] grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* BLOCK 1: TRADE DEFINITION */}
          <div className="rounded-md overflow-hidden border border-[#E5E9EF] dark:border-[#2A2D30] bg-white dark:bg-[#151717]">
            <div className="px-3 py-2 bg-[#203DA8] text-white text-xs font-semibold">
              1. Trade Definition
            </div>
            <div className="p-3 space-y-2.5 text-xs">
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Strategy Name</label>
                <input
                  type="text"
                  value={botName}
                  onChange={(e) => setBotName(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Market Symbol</label>
                <select
                  value={blockSymbol}
                  onChange={(e) => setBlockSymbol(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                >
                  {symbols.slice(0, 80).map((s) => (
                    <option key={s.symbol} value={s.symbol}>
                      {s.display_name} ({s.symbol})
                    </option>
                  ))}
                  {symbols.length === 0 && <option value={blockSymbol}>{blockSymbol}</option>}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Contract Family</label>
                <select
                  value={blockFamily}
                  onChange={(e) => setBlockFamily(e.target.value as any)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                >
                  <option value="CALL_PUT">Rise / Fall (CALL / PUT)</option>
                  <option value="DIGITDIFF">Digit Differs</option>
                  <option value="DIGITMATCH">Digit Matches</option>
                  <option value="DIGITEVEN_ODD">Even / Odd</option>
                </select>
              </div>
            </div>
          </div>

          {/* BLOCK 2: SIGNAL & ENTRY CONDITION */}
          <div className="rounded-md overflow-hidden border border-[#E5E9EF] dark:border-[#2A2D30] bg-white dark:bg-[#151717]">
            <div className="px-3 py-2 bg-[#203DA8] text-white text-xs font-semibold">
              2. Entry Condition
            </div>
            <div className="p-3 space-y-2.5 text-xs">
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Candle Timeframe</label>
                <select
                  value={blockTimeframe}
                  onChange={(e) => setBlockTimeframe(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                >
                  {['M1', 'M5', 'M15', 'M30', 'H1'].map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Min Signal Confidence (0–1)</label>
                <input
                  type="number"
                  min="0.5"
                  max="0.95"
                  step="0.05"
                  value={blockMinConf}
                  onChange={(e) => setBlockMinConf(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Assumed Payout Multiplier</label>
                <input
                  type="number"
                  min="0.1"
                  max="9"
                  step="0.05"
                  value={blockPayout}
                  onChange={(e) => setBlockPayout(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
            </div>
          </div>

          {/* BLOCK 3: STAKE & DURATION */}
          <div className="rounded-md overflow-hidden border border-[#E5E9EF] dark:border-[#2A2D30] bg-white dark:bg-[#151717]">
            <div className="px-3 py-2 bg-[#203DA8] text-white text-xs font-semibold">
              3. Stake & Risk Cap
            </div>
            <div className="p-3 space-y-2.5 text-xs">
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Stake % of Paper Equity (max 2%)</label>
                <input
                  type="number"
                  min="0.1"
                  max="2"
                  step="0.1"
                  value={blockRiskPct}
                  onChange={(e) => setBlockRiskPct(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Contract Duration (sec)</label>
                <input
                  type="number"
                  min="15"
                  max="3600"
                  value={blockExpirySec}
                  onChange={(e) => setBlockExpirySec(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#65727E] mb-1">Post-Trade Cooldown (sec)</label>
                <input
                  type="number"
                  min="10"
                  max="3600"
                  value={blockCooldown}
                  onChange={(e) => setBlockCooldown(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono rounded bg-[#F1F2F4] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30]"
                />
              </div>
            </div>
          </div>

          {/* BLOCK 4: AUTOMATION MODE */}
          <div className="rounded-md overflow-hidden border border-[#E5E9EF] dark:border-[#2A2D30] bg-white dark:bg-[#151717]">
            <div className="px-3 py-2 bg-[#203DA8] text-white text-xs font-semibold">
              4. Execution & Safety
            </div>
            <div className="p-3 space-y-3 text-xs">
              <div className="p-2.5 rounded bg-[#20B7C6]/15 border border-[#20B7C6]/40 text-[#263238] dark:text-white">
                Mode: <strong>Paper Virtual Funds Only</strong>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoEnableOnCreate}
                  onChange={(e) => setAutoEnableOnCreate(e.target.checked)}
                  className="accent-[#20B7C6]"
                />
                <span>Allow Paper Auto-Scheduler</span>
              </label>
              <p className="text-[11px] text-[#65727E]">
                Enforces 5% daily loss stop and bounded recovery policy automatically.
              </p>
            </div>
          </div>
        </div>

        {statusMsg && (
          <div className="px-4 py-2 text-xs bg-[#F5F7FA] dark:bg-[#1D1F20] border-t border-[#E5E9EF] dark:border-[#2A2D30] text-[#20242B] dark:text-white">
            {statusMsg}
          </div>
        )}
      </div>

      {/* PAPER AUTOMATION SCHEDULER + SAVED STRATEGIES */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-2.5">
            <div>
              <h3 className="text-sm font-semibold text-[#20242B] dark:text-white">Paper Automation Control</h3>
              <p className="text-xs text-[#6B7280]">
                Status:{' '}
                <strong className={automation?.control.enabled && !automation?.control.kill_switch ? 'text-[#00A88F]' : 'text-[#FF4D5A]'}>
                  {automation?.control.enabled && !automation?.control.kill_switch ? 'RUNNING (PAPER)' : 'PAUSED'}
                </strong>
              </p>
            </div>
            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await dqiApi.runAutomationOnce();
                  setStatusMsg(`Cycle ran: ${res.executed} opened, ${res.settled} settled${res.skippedReason ? ` (${res.skippedReason})` : ''}.`);
                  await refreshWorkspace();
                } finally {
                  setBusy(false);
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded border border-[#E5E9EF] dark:border-[#2A2D30] hover:bg-[#F5F7FA] dark:hover:bg-[#1D1F20] flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Run Cycle
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                await dqiApi.setAutomationControl(true, false, 'Enabled by operator');
                await refreshWorkspace();
              }}
              className="px-3.5 py-2 text-xs font-semibold rounded bg-[#00A88F] hover:bg-[#00927C] text-white flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" />
              Enable Paper Bot
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                await dqiApi.setAutomationControl(false, true, 'Emergency stop clicked');
                await refreshWorkspace();
              }}
              className="px-3.5 py-2 text-xs font-semibold rounded bg-[#FF444F] hover:bg-[#EB3E48] text-white flex items-center gap-1.5"
            >
              <Square className="w-3.5 h-3.5" />
              Emergency Stop
            </button>
          </div>

          <div className="space-y-2 pt-2 border-t border-[#E5E9EF] dark:border-[#2A2D30] max-h-[200px] overflow-y-auto">
            {savedStrategies.length === 0 ? (
              <p className="text-xs text-[#6B7280] py-4 text-center">No saved strategies yet. Build one above.</p>
            ) : (
              savedStrategies.map((st) => (
                <div
                  key={st.strategy_id}
                  className="p-2.5 rounded bg-[#F5F7FA] dark:bg-[#1D1F20] flex items-center justify-between gap-2 text-xs"
                >
                  <div>
                    <div className="font-semibold text-[#20242B] dark:text-white">{st.name}</div>
                    <div className="text-[11px] font-mono text-[#6B7280]">
                      {st.symbol_code} · {st.timeframe} · {(st.risk_fraction * 100).toFixed(2)}% stake
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await dqiApi.toggleStrategy(st.strategy_id, true, !st.auto_enabled);
                      await refreshWorkspace();
                    }}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold ${
                      st.auto_enabled ? 'bg-[#20B7C6] text-[#101820]' : 'bg-[#E5E9EF] dark:bg-[#2A2D30] text-[#6B7280]'
                    }`}
                  >
                    {st.auto_enabled ? 'Auto ON' : 'Auto OFF'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* PRELOADED DBOT XML LIBRARY & DERIV CSV REPLAY */}
        <div className="lg:col-span-7 bg-white dark:bg-[#151717] border border-[#E5E9EF] dark:border-[#2A2D30] rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E9EF] dark:border-[#2A2D30] pb-2.5">
            <div>
              <h3 className="text-sm font-semibold text-[#20242B] dark:text-white flex items-center gap-1.5">
                <FileSpreadsheet className="w-4 h-4 text-[#0866FF]" />
                Uploaded Deriv Bot XMLs & CSV Statement Replay
              </h3>
              <p className="text-xs text-[#6B7280]">
                {csvStats
                  ? `CSV: ${csvStats.totalTrades} trades · ${csvStats.winRate}% win rate · Net $${csvStats.netProfit.toFixed(2)}`
                  : 'Loading transaction CSV…'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {xmlStrategies.map((bot) => {
              const active = selectedXml?.id === bot.id;
              return (
                <div
                  key={bot.id}
                  onClick={() => handleLoadXmlIntoBuilder(bot)}
                  className={`p-3 rounded-md border cursor-pointer transition-colors text-xs ${
                    active
                      ? 'border-[#20B7C6] bg-[#20B7C6]/10'
                      : 'border-[#E5E9EF] dark:border-[#2A2D30] bg-[#F5F7FA] dark:bg-[#1D1F20] hover:border-[#0866FF]'
                  }`}
                >
                  <div className="font-semibold text-[#20242B] dark:text-white">{bot.name}</div>
                  <div className="text-[11px] font-mono text-[#6B7280] mt-0.5">
                    {bot.symbol} · {bot.purchaseType} · Base ${bot.initialStake} · TP ${bot.profitThreshold} / SL ${bot.lossThreshold}
                  </div>
                </div>
              );
            })}
          </div>

          {selectedXml && replaySummary && (
            <div className="p-3 rounded-md bg-[#F5F7FA] dark:bg-[#1D1F20] border border-[#E5E9EF] dark:border-[#2A2D30] flex flex-wrap items-center justify-between gap-3 text-xs">
              <div>
                <span className="text-[#6B7280]">CSV Replay ({selectedXml.name}): </span>
                <strong className={`font-mono ${replaySummary.finalProfit >= 0 ? 'text-[#00A88F]' : 'text-[#FF4D5A]'}`}>
                  {replaySummary.finalProfit >= 0 ? '+' : ''}${replaySummary.finalProfit.toFixed(2)}
                </strong>
                <span className="text-[#6B7280] ml-3 font-mono">Max DD ${replaySummary.maxDrawdown.toFixed(2)}</span>
              </div>
              {replaySummary.stopReason && (
                <span className="text-[11px] text-[#FFAD3A] flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {replaySummary.stopReason}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
