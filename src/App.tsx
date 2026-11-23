import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Blocks,
  CandlestickChart,
  Hash,
  Moon,
  Radar,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { dqiApi } from './services/dqiApi';
import type { ActiveSymbol, DqiTab, LiveTickEvent, PaperAccount } from './types/dqi';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { DigitsStudio } from './components/DigitsStudio';
import { QuantScannerWorkspace } from './components/QuantScannerWorkspace';
import { StrategyBuilderWorkspace } from './components/StrategyBuilderWorkspace';
import { RiskAccountsWorkspace } from './components/RiskAccountsWorkspace';

const TABS: Array<{
  id: DqiTab;
  label: string;
  shortDesc: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'terminal', label: 'Terminal', shortDesc: 'Live chart & paper trade', icon: CandlestickChart },
  { id: 'digits', label: 'Digits Studio', shortDesc: 'Last-digit frequency & Match/Differ', icon: Hash },
  { id: 'scanner', label: 'Quant Scanner', shortDesc: 'Indicators, scan & backtest', icon: Radar },
  { id: 'strategy', label: 'Strategy & Paper', shortDesc: 'Bot blocks, XML & scheduler', icon: Blocks },
  { id: 'risk', label: 'Risk & Accounts', shortDesc: 'Recovery caps, OAuth & DB', icon: ShieldCheck },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<DqiTab>('terminal');
  const [darkMode, setDarkMode] = useState(false);

  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('1HZ100V');

  const [latestTick, setLatestTick] = useState<LiveTickEvent | null>(null);
  const [liveTapeBuffer, setLiveTapeBuffer] = useState<LiveTickEvent[]>([]);
  const [feedHealth, setFeedHealth] = useState<{
    state: string;
    isStale: boolean;
    ageSeconds: number | null;
  }>({
    state: 'CONNECTING',
    isStale: false,
    ageSeconds: null,
  });

  const [paperAccount, setPaperAccount] = useState<PaperAccount | null>(null);
  const [derivConnected, setDerivConnected] = useState(false);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);

  // Sync dark mode class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Check query string after OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthState = params.get('deriv_oauth');
    const oauthErr = params.get('oauth_error');
    if (oauthState === 'connected') {
      setGlobalNotice('Deriv account connected via OAuth 2.0 PKCE.');
      setActiveTab('risk');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (oauthErr) {
      setGlobalNotice(`Deriv OAuth notice: ${oauthErr}`);
      setActiveTab('risk');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const loadSymbols = useCallback(async (refresh = false) => {
    setSymbolsError(null);
    try {
      const res = await dqiApi.getSymbols(refresh);
      const list = res.symbols || [];
      setSymbols(list);
      if (list.length > 0 && !list.some((s) => s.symbol === selectedSymbol)) {
        const preferred =
          list.find((s) => s.symbol === '1HZ100V') ||
          list.find((s) => s.symbol === 'R_100') ||
          list[0];
        if (preferred) setSelectedSymbol(preferred.symbol);
      }
    } catch (err) {
      setSymbolsError(err instanceof Error ? err.message : 'Unable to load Deriv active symbols');
    }
  }, [selectedSymbol]);

  const refreshSystemState = useCallback(async () => {
    try {
      const [acct, auth, live] = await Promise.all([
        dqiApi.getPaperAccount(),
        dqiApi.getDerivAuthStatus(),
        dqiApi.getLiveControl(),
      ]);
      setPaperAccount(acct);
      setDerivConnected(auth.connected);
      setKillSwitchActive(Boolean(live.control?.kill_switch));
    } catch {
      // Keep non-fatal background sync silent unless user opens Risk workspace
    }
  }, []);

  useEffect(() => {
    void loadSymbols(false);
    void refreshSystemState();
    const timer = window.setInterval(() => {
      void refreshSystemState();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadSymbols, refreshSystemState]);

  // Live SSE market tick subscription for selected symbol
  useEffect(() => {
    setLatestTick(null);
    setLiveTapeBuffer([]);
    setFeedHealth({ state: 'CONNECTING', isStale: false, ageSeconds: null });

    const unsubscribe = dqiApi.subscribeLiveStream(selectedSymbol, {
      onReady: () => {
        setFeedHealth((prev) => ({ ...prev, state: 'CONNECTED' }));
      },
      onHistory: (ticks) => {
        if (ticks.length > 0) {
          const ordered = [...ticks].slice(-120);
          setLiveTapeBuffer(ordered);
          setLatestTick(ordered[ordered.length - 1]);
          setFeedHealth({ state: 'LIVE', isStale: false, ageSeconds: 0 });
        }
      },
      onTick: (tick) => {
        setLatestTick(tick);
        setLiveTapeBuffer((prev) => [...prev.slice(-119), tick]);
        setFeedHealth({ state: 'LIVE', isStale: false, ageSeconds: 0 });
      },
      onHealth: (h) => {
        setFeedHealth({
          state: h.connectionState,
          isStale: h.isStale,
          ageSeconds: h.ageSeconds,
        });
      },
      onError: (msg) => {
        setFeedHealth((prev) => ({
          ...prev,
          state: msg.includes('reconnect') ? 'RECONNECTING' : 'DISCONNECTED',
        }));
      },
    });

    return () => unsubscribe();
  }, [selectedSymbol]);

  const handleQuickKillSwitch = async () => {
    try {
      await dqiApi.activateKillSwitch();
      setKillSwitchActive(true);
      setGlobalNotice('Emergency Kill Switch activated. All automation and live gates halted.');
    } catch (err) {
      setGlobalNotice(err instanceof Error ? err.message : 'Kill switch request failed');
    }
  };

  const activeSymbolMeta = symbols.find((s) => s.symbol === selectedSymbol);

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#20242B] antialiased dark:bg-[#0D131A] dark:text-[#F3F4F6]">
      <div className="flex min-h-screen">
        {/* Desktop Sidebar (#101820 Official Deriv Dark Navy) */}
        <aside className="hidden w-60 shrink-0 flex-col justify-between bg-[#101820] text-white lg:flex">
          <div>
            <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#FF444F] text-white">
                <BarChart3 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold tracking-tight text-white">
                  Deriv Quant
                </div>
                <div className="truncate text-[11px] text-[#9CA3AF]">
                  Intelligence Terminal
                </div>
              </div>
            </div>

            <nav className="space-y-1 px-2.5 py-4" aria-label="Primary sections">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left transition ${
                      active
                        ? 'bg-[#0866FF] text-white'
                        : 'text-[#D1D5DB] hover:bg-white/8 hover:text-white'
                    }`}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold">{tab.label}</div>
                      <div
                        className={`truncate text-[11px] ${
                          active ? 'text-white/80' : 'text-[#9CA3AF]'
                        }`}
                      >
                        {tab.shortDesc}
                      </div>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-2.5 border-t border-white/10 p-4 text-xs">
            <div className="rounded-md bg-white/5 p-3">
              <div className="text-[11px] text-[#9CA3AF]">Paper Equity (Virtual)</div>
              <div className="mt-0.5 font-mono text-base font-bold tabular-nums text-[#00A88F]">
                ${paperAccount ? paperAccount.current_equity.toFixed(2) : '10000.00'}
              </div>
              <div className="mt-1 text-[11px] text-[#9CA3AF]">
                {derivConnected ? 'Deriv OAuth Connected' : 'Real Execution Locked'}
              </div>
            </div>

            <button
              type="button"
              onClick={handleQuickKillSwitch}
              className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition ${
                killSwitchActive
                  ? 'bg-[#FF444F]/25 text-[#FF8890]'
                  : 'bg-[#FF444F] text-white hover:bg-[#e53843]'
              }`}
            >
              <AlertOctagon className="h-3.5 w-3.5" />
              {killSwitchActive ? 'Kill Switch Active' : 'Emergency Kill Switch'}
            </button>
          </div>
        </aside>

        {/* Main Content Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Clean 3-Zone Top Header */}
          <header className="sticky top-0 z-20 border-b border-[#E5E9EF] bg-white px-4 py-2.5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Zone 1: Brand (visible on mobile/tablet) & Active Symbol Snapshot */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 lg:hidden">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-[#FF444F] text-white">
                    <BarChart3 className="h-4 w-4" />
                  </div>
                  <span className="text-sm font-bold text-[#20242B] dark:text-white">
                    Deriv Quant Intelligence
                  </span>
                </div>

                <div className="hidden items-center gap-3 sm:flex">
                  <div>
                    <div className="text-xs font-bold text-[#20242B] dark:text-white">
                      {activeSymbolMeta?.display_name || selectedSymbol}
                    </div>
                    <div className="font-mono text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                      {selectedSymbol} · {activeSymbolMeta?.market_display_name || 'Deriv Feed'}
                    </div>
                  </div>
                  <div className="h-6 w-px bg-[#E5E9EF] dark:bg-[#243040]" />
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-[#6B7280] dark:text-[#9CA3AF]">
                      Spot Price
                    </div>
                    <div className="font-mono text-sm font-bold tabular-nums text-[#20242B] dark:text-white">
                      {latestTick ? latestTick.rawQuote : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-[#6B7280] dark:text-[#9CA3AF]">
                      Last Digit
                    </div>
                    <div className="font-mono text-sm font-bold tabular-nums text-[#0866FF]">
                      {latestTick ? latestTick.lastDigit : '—'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Zone 2: Horizontal Navigation (responsive) */}
              <div className="flex items-center gap-1 overflow-x-auto lg:hidden">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold ${
                      activeTab === tab.id
                        ? 'bg-[#0866FF] text-white'
                        : 'text-[#6B7280] hover:bg-[#F5F7FA] dark:text-[#9CA3AF] dark:hover:bg-[#0F151D]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Zone 3: Feed Status + Theme Toggle + Primary Action */}
              <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1.5 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1 text-xs dark:border-[#243040] dark:bg-[#0F151D]">
                  <Activity
                    className={`h-3.5 w-3.5 ${
                      feedHealth.state === 'LIVE' && !feedHealth.isStale
                        ? 'text-[#00A88F]'
                        : feedHealth.isStale
                        ? 'text-[#FFAD3A]'
                        : 'text-[#6B7280]'
                    }`}
                  />
                  <span className="font-mono text-[11px] font-semibold">
                    {feedHealth.isStale ? 'STALE' : feedHealth.state}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setDarkMode((v) => !v)}
                  aria-label="Toggle color theme"
                  className="rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-1.5 text-[#20242B] hover:bg-[#EAEFF5] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
                >
                  {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('risk')}
                  className="rounded-md bg-[#0866FF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0654d4]"
                >
                  {derivConnected ? 'Deriv Connected' : 'Connect Deriv'}
                </button>
              </div>
            </div>
          </header>

          {globalNotice && (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border border-[#0866FF]/30 bg-[#0866FF]/10 px-4 py-2 text-xs text-[#20242B] dark:text-[#F3F4F6]">
              <span>{globalNotice}</span>
              <button
                type="button"
                onClick={() => setGlobalNotice(null)}
                className="font-semibold underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Active Workspace Canvas */}
          <main className="flex-1 p-4">
            {activeTab === 'terminal' && (
              <TerminalWorkspace
                symbols={symbols}
                symbolsError={symbolsError}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                latestTick={latestTick}
                feedHealth={feedHealth}
                onOpenDigits={() => setActiveTab('digits')}
                onRefreshSymbols={() => void loadSymbols(true)}
              />
            )}

            {activeTab === 'digits' && (
              <DigitsStudio
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                latestTick={latestTick}
                liveTapeBuffer={liveTapeBuffer}
              />
            )}

            {activeTab === 'scanner' && (
              <QuantScannerWorkspace
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                onJumpToTerminal={() => setActiveTab('terminal')}
              />
            )}

            {activeTab === 'strategy' && (
              <StrategyBuilderWorkspace
                symbols={symbols}
                selectedSymbol={selectedSymbol}
              />
            )}

            {activeTab === 'risk' && (
              <RiskAccountsWorkspace
                paperAccount={paperAccount}
                onRefreshSystem={() => void refreshSystemState()}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
