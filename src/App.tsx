import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Blocks,
  Bot,
  CandlestickChart,
  ExternalLink,
  Hash,
  Moon,
  Radar,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { dqiApi } from './services/dqiApi';
import type {
  ActiveSymbol,
  DerivSessionState,
  DqiTab,
  LiveDerivContract,
  LiveTickEvent,
  PaperAccount,
} from './types/dqi';
import { AnalyserBotWorkspace } from './components/AnalyserBotWorkspace';
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
  { id: 'analyser', label: 'AI Analyser', shortDesc: 'Beginner signal & AI brief', icon: Bot },
  { id: 'terminal', label: 'Terminal', shortDesc: 'Live chart & order ticket', icon: CandlestickChart },
  { id: 'digits', label: 'Digits Studio', shortDesc: 'Last-digit & Match/Differ', icon: Hash },
  { id: 'scanner', label: 'Quant Scanner', shortDesc: 'Indicators, scan & backtest', icon: Radar },
  { id: 'strategy', label: 'Strategy & Bots', shortDesc: 'Bot blocks, XML & scheduler', icon: Blocks },
  { id: 'risk', label: 'Risk & Accounts', shortDesc: 'Demo/Real switch, OAuth & DB', icon: ShieldCheck },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<DqiTab>('analyser');
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
  const [derivSession, setDerivSession] = useState<DerivSessionState>(() => dqiApi.getDerivSession());
  const [liveContracts, setLiveContracts] = useState<LiveDerivContract[]>([]);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);

  // Quick Deriv Connect Modal
  const [connectOpen, setConnectOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  // Sync dark mode class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Subscribe to real-time Deriv Session (Demo + Real balances) & live contracts
  useEffect(() => {
    const unsubSess = dqiApi.subscribeDerivSession(setDerivSession);
    const unsubContracts = dqiApi.subscribeDerivContracts(setLiveContracts);
    return () => {
      unsubSess();
      unsubContracts();
    };
  }, []);

  // Load server App ID + parse Deriv OAuth callback tokens (?acct1=...&token1=...&cur1=...)
  useEffect(() => {
    void (async () => {
      try {
        const st = await dqiApi.getSystemStatus();
        if (st?.derivAppId) dqiApi.setDerivAppId(st.derivAppId);
      } catch {
        // fallback to default app id 1089
      }

      const params = new URLSearchParams(window.location.search);
      const oauthAccounts: Array<{ loginid: string; token: string; currency?: string }> = [];
      for (let i = 1; i <= 10; i += 1) {
        const acct = params.get(`acct${i}`);
        const token = params.get(`token${i}`);
        const cur = params.get(`cur${i}`) ?? undefined;
        if (acct && token) {
          oauthAccounts.push({ loginid: acct, token, currency: cur });
        }
      }

      if (oauthAccounts.length > 0) {
        // Immediately scrub tokens from address bar
        window.history.replaceState({}, '', window.location.pathname);
        try {
          const s = await dqiApi.authorizeDerivOAuthAccounts(oauthAccounts);
          setGlobalNotice(
            `Connected Deriv (${oauthAccounts.length} account(s) loaded). Active: ${s.activeIsVirtual ? 'DEMO' : 'REAL'} ${s.activeLoginId}.`
          );
        } catch (err) {
          setGlobalNotice(err instanceof Error ? err.message : 'Deriv OAuth authorization failed');
        }
        return;
      }

      const oauthState = params.get('deriv_oauth') || params.get('deriv');
      const oauthErr = params.get('oauth_error');
      if (oauthState === 'connected') {
        setGlobalNotice('Deriv account connected.');
        setActiveTab('risk');
        window.history.replaceState({}, '', window.location.pathname);
      } else if (oauthErr) {
        setGlobalNotice(`Deriv OAuth notice: ${oauthErr}`);
        setActiveTab('risk');
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []);

  const loadSymbols = useCallback(
    async (refresh = false) => {
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
    },
    [selectedSymbol]
  );

  const refreshSystemState = useCallback(async () => {
    try {
      const [acct, live] = await Promise.all([
        dqiApi.getPaperAccount(),
        dqiApi.getLiveControl(),
      ]);
      setPaperAccount(acct);
      setKillSwitchActive(Boolean(live.control?.kill_switch));
    } catch {
      // non-fatal background sync
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

  // Direct Real-Time Deriv Browser WebSocket tick stream
  useEffect(() => {
    setLatestTick(null);
    setLiveTapeBuffer([]);
    setFeedHealth({ state: 'CONNECTING', isStale: false, ageSeconds: null });

    const unsubscribe = dqiApi.subscribeLiveStream(selectedSymbol, {
      onReady: () => {
        setFeedHealth((prev) => ({ ...prev, state: 'LIVE' }));
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
      onError: () => {
        setFeedHealth((prev) => ({ ...prev, state: 'RECONNECTING' }));
      },
    });

    return () => unsubscribe();
  }, [selectedSymbol]);

  const handleQuickKillSwitch = async () => {
    try {
      if (killSwitchActive) {
        await dqiApi.resetKillSwitch();
        setKillSwitchActive(false);
        setGlobalNotice('Kill switch reset to READY.');
      } else {
        await dqiApi.activateKillSwitch();
        setKillSwitchActive(true);
        setGlobalNotice('Emergency Kill Switch activated.');
      }
    } catch (err) {
      setGlobalNotice(err instanceof Error ? err.message : 'Kill switch update failed');
    }
  };

  const handleOAuthLogin = async () => {
    setConnectBusy(true);
    setConnectErr(null);
    try {
      const res = await dqiApi.startDerivOAuth();
      window.location.assign(res.authorizationUrl);
    } catch (err) {
      setConnectErr(err instanceof Error ? err.message : 'Could not start Deriv OAuth');
      setConnectBusy(false);
    }
  };

  const handleTokenLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setConnectBusy(true);
    setConnectErr(null);
    try {
      const s = await dqiApi.authorizeDerivToken(tokenInput.trim());
      setTokenInput('');
      setConnectOpen(false);
      setGlobalNotice(
        `Connected ${s.activeIsVirtual ? 'Deriv Demo' : 'Deriv REAL'} (${s.activeLoginId}) · Balance ${s.activeBalance?.toFixed(2)} ${s.activeCurrency}`
      );
    } catch (err) {
      setConnectErr(err instanceof Error ? err.message : 'Invalid API token');
    } finally {
      setConnectBusy(false);
    }
  };

  const handleAccountSelectChange = async (loginid: string) => {
    const target = derivSession.accounts.find((a) => a.loginid === loginid);
    if (!target) return;
    if (!target.hasToken) {
      setActiveTab('risk');
      setGlobalNotice(`Attach an API Token for ${loginid} in Risk & Accounts (or use Deriv OAuth) to switch.`);
      return;
    }
    try {
      const s = await dqiApi.switchDerivAccount(loginid);
      setGlobalNotice(
        `Switched active account to ${s.activeIsVirtual ? 'DEMO' : 'REAL'} (${s.activeLoginId}).`
      );
    } catch (err) {
      setGlobalNotice(err instanceof Error ? err.message : 'Account switch failed');
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
                  AI Analyser Terminal
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
                      <div className={`truncate text-[11px] ${active ? 'text-white/80' : 'text-[#9CA3AF]'}`}>
                        {tab.shortDesc}
                      </div>
                    </div>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Live Deriv Account Balance Panel in Sidebar */}
          <div className="space-y-2.5 border-t border-white/10 p-4 text-xs">
            <div className="rounded-md bg-white/5 p-3">
              {derivSession.connected ? (
                <>
                  <div className="flex items-center justify-between">
                    <span
                      className={`font-mono text-[11px] font-bold ${
                        derivSession.activeIsVirtual ? 'text-[#00A88F]' : 'text-[#FF444F]'
                      }`}
                    >
                      {derivSession.activeIsVirtual ? 'DERIV DEMO' : 'DERIV REAL'}
                    </span>
                    <span className="font-mono text-[11px] text-[#9CA3AF]">
                      {derivSession.activeLoginId}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-base font-bold tabular-nums text-white">
                    {derivSession.activeBalance !== null
                      ? `${derivSession.activeBalance.toFixed(2)} ${derivSession.activeCurrency}`
                      : 'Loading…'}
                  </div>
                  {derivSession.accounts.length > 1 && (
                    <select
                      aria-label="Switch Deriv Demo or Real account"
                      value={derivSession.activeLoginId || ''}
                      onChange={(e) => void handleAccountSelectChange(e.target.value)}
                      className="mt-2 w-full rounded bg-[#1A2430] px-2 py-1 text-[11px] text-white outline-none"
                    >
                      {derivSession.accounts.map((a) => (
                        <option key={a.loginid} value={a.loginid}>
                          {a.isVirtual ? 'DEMO' : 'REAL'} · {a.loginid} (
                          {a.balance !== null ? `${a.balance.toFixed(2)} ${a.currency}` : a.currency})
                        </option>
                      ))}
                    </select>
                  )}
                </>
              ) : (
                <>
                  <div className="text-[11px] text-[#9CA3AF]">Deriv Account</div>
                  <div className="mt-0.5 text-xs font-semibold text-white">Not Connected</div>
                  <button
                    type="button"
                    onClick={() => setConnectOpen(true)}
                    className="mt-2 w-full rounded bg-[#0866FF] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#0654d4]"
                  >
                    Connect Demo / Real
                  </button>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={handleQuickKillSwitch}
              className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition ${
                killSwitchActive
                  ? 'bg-[#00A88F] text-white hover:bg-[#00917b]'
                  : 'bg-[#FF444F] text-white hover:bg-[#e53843]'
              }`}
            >
              <AlertOctagon className="h-3.5 w-3.5" />
              {killSwitchActive ? 'Reset Kill Switch' : 'Emergency Kill Switch'}
            </button>
          </div>
        </aside>

        {/* Main Content Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Clean 3-Zone Top Header */}
          <header className="sticky top-0 z-20 border-b border-[#E5E9EF] bg-white px-4 py-2.5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Zone 1: Brand / Active Symbol */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 lg:hidden">
                  <div className="flex h-7 w-7 items-center justify-center rounded bg-[#FF444F] text-white">
                    <BarChart3 className="h-4 w-4" />
                  </div>
                  <span className="whitespace-nowrap text-sm font-bold text-[#20242B] dark:text-white">
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

              {/* Zone 2: Horizontal Navigation (mobile/tablet) */}
              <div className="flex items-center gap-1 overflow-x-auto lg:hidden">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold ${
                      activeTab === tab.id
                        ? 'bg-[#0866FF] text-white'
                        : 'text-[#6B7280] hover:bg-[#F5F7FA] dark:text-[#9CA3AF] dark:hover:bg-[#0F151D]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Zone 3: Feed Status + Theme Toggle + Deriv Account / Connect */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-2.5 py-1 text-xs dark:border-[#243040] dark:bg-[#0F151D]">
                  <Activity
                    className={`h-3.5 w-3.5 ${
                      feedHealth.state === 'LIVE' && !feedHealth.isStale
                        ? 'text-[#00A88F]'
                        : 'text-[#FFAD3A]'
                    }`}
                  />
                  <span className="font-mono text-[11px] font-semibold">
                    {feedHealth.state}
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

                {derivSession.connected ? (
                  <button
                    type="button"
                    onClick={() => setActiveTab('risk')}
                    className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-xs font-bold tabular-nums text-white ${
                      derivSession.activeIsVirtual
                        ? 'bg-[#00A88F] hover:bg-[#00917b]'
                        : 'bg-[#FF444F] hover:bg-[#e53843]'
                    }`}
                  >
                    {derivSession.activeIsVirtual ? 'DEMO' : 'REAL'} ·{' '}
                    {derivSession.activeBalance !== null
                      ? `$${derivSession.activeBalance.toFixed(2)}`
                      : derivSession.activeLoginId}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConnectOpen(true)}
                    className="whitespace-nowrap rounded-md bg-[#0866FF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0654d4]"
                  >
                    Connect Deriv
                  </button>
                )}
              </div>
            </div>
          </header>

          {globalNotice && (
            <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-md border border-[#0866FF]/30 bg-[#0866FF]/10 px-4 py-2 text-xs text-[#20242B] dark:text-[#F3F4F6]">
              <span>{globalNotice}</span>
              <button type="button" onClick={() => setGlobalNotice(null)} className="font-semibold underline">
                Dismiss
              </button>
            </div>
          )}

          {/* Active Workspace Canvas */}
          <main className="flex-1 p-4">
            {activeTab === 'analyser' && (
              <AnalyserBotWorkspace
                symbols={symbols}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                latestTick={latestTick}
                liveTapeBuffer={liveTapeBuffer}
                derivSession={derivSession}
                liveContracts={liveContracts}
                onOpenConnect={() => setConnectOpen(true)}
                onJumpToTab={setActiveTab}
              />
            )}

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
                onOpenConnect={() => setConnectOpen(true)}
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
              <StrategyBuilderWorkspace symbols={symbols} selectedSymbol={selectedSymbol} />
            )}

            {activeTab === 'risk' && (
              <RiskAccountsWorkspace
                paperAccount={paperAccount}
                derivSession={derivSession}
                onRefreshSystem={() => void refreshSystemState()}
              />
            )}
          </main>
        </div>
      </div>

      {/* Quick Connect Deriv Modal (OAuth + Instant API Token) */}
      {connectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between border-b border-[#E5E9EF] pb-3 dark:border-[#243040]">
              <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                Connect Your Deriv Account
              </h2>
              <button
                type="button"
                onClick={() => setConnectOpen(false)}
                className="rounded p-1 text-[#6B7280] hover:bg-[#F5F7FA] dark:hover:bg-[#0F151D]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-xs">
              {connectErr && (
                <div className="rounded border border-[#FF444F]/40 bg-[#FF444F]/10 p-2.5 text-[#FF444F]">
                  {connectErr}
                </div>
              )}

              <div>
                <div className="font-semibold text-[#20242B] dark:text-white">
                  Option 1 — Instant Connect with Deriv API Token (Fastest)
                </div>
                <p className="mt-1 text-[#6B7280] dark:text-[#9CA3AF]">
                  Create a token on Deriv (<strong>Account Settings → API Token</strong> with <strong>Read + Trade</strong> enabled) and paste it below. Starts on Demo or Real matching your token.
                </p>
                <form onSubmit={handleTokenLogin} className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste your Deriv API Token"
                    className="min-w-0 flex-1 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2 text-xs text-[#20242B] outline-none focus:border-[#0866FF] dark:border-[#243040] dark:bg-[#0F151D] dark:text-white"
                  />
                  <button
                    type="submit"
                    disabled={connectBusy || !tokenInput.trim()}
                    className="rounded-md bg-[#00A88F] px-3.5 py-2 font-semibold text-white hover:bg-[#00917b] disabled:opacity-50"
                  >
                    {connectBusy ? 'Connecting…' : 'Connect'}
                  </button>
                </form>
              </div>

              <div className="border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
                <div className="font-semibold text-[#20242B] dark:text-white">
                  Option 2 — Login via Deriv OAuth (Demo + Real Switcher)
                </div>
                <p className="mt-1 text-[#6B7280] dark:text-[#9CA3AF]">
                  Loads all your linked Deriv Demo (VRTC) and Real (CR) accounts together. Uses App ID{' '}
                  <span className="font-mono font-semibold">{derivSession.appId}</span>.
                </p>
                <button
                  type="button"
                  disabled={connectBusy}
                  onClick={handleOAuthLogin}
                  className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md bg-[#0866FF] px-4 py-2 font-semibold text-white hover:bg-[#0654d4] disabled:opacity-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Continue with Deriv OAuth
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
