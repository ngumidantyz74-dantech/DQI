import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  ExternalLink,
  Moon,
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
import { RiskAccountsWorkspace } from './components/RiskAccountsWorkspace';

const PARTNER_REF_CODE = '352P3WGh6Jm4clLrnbq6u';
const DEFAULT_CALLBACK_URI = 'https://dqideriv.pipflowtrade.site/api/v1/auth/deriv/callback';

const NAV_TABS: Array<{ id: DqiTab; label: string }> = [
  { id: 'analyser', label: 'Bot & Scanner' },
  { id: 'digits', label: 'Digits' },
  { id: 'terminal', label: 'Live Chart' },
  { id: 'risk', label: 'Accounts' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<DqiTab>('analyser');
  const [darkMode, setDarkMode] = useState(false);

  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(() => {
    try {
      return window.localStorage.getItem('dqi_selected_symbol') || '1HZ15V';
    } catch {
      return '1HZ15V';
    }
  });

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
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);

  // Connect Deriv Modal
  const [connectOpen, setConnectOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [configuredAppId, setConfiguredAppId] = useState(PARTNER_REF_CODE);
  const [configuredRedirectUri, setConfiguredRedirectUri] = useState(DEFAULT_CALLBACK_URI);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem('dqi_selected_symbol', selectedSymbol);
    } catch {
      // ignore storage errors
    }
  }, [selectedSymbol]);

  // Subscribe to real-time Deriv Session (Demo + Real balances) & live contracts
  useEffect(() => {
    const unsubSess = dqiApi.subscribeDerivSession(setDerivSession);
    const unsubContracts = dqiApi.subscribeDerivContracts(setLiveContracts);
    return () => {
      unsubSess();
      unsubContracts();
    };
  }, []);

  // Automatic Deriv OAuth2 session restoration, callback parser, and config loader
  useEffect(() => {
    void (async () => {
      try {
        const [st, authSt] = await Promise.all([
          dqiApi.getSystemStatus().catch(() => null),
          dqiApi.getDerivAuthStatus().catch(() => null),
        ]);
        if (st?.derivWsUrl) dqiApi.setDerivWsBaseUrl(st.derivWsUrl);
        if (st?.derivAppId && /^\d+$/.test(st.derivAppId)) {
          dqiApi.setDerivAppId(st.derivAppId);
        }
        if (authSt?.appId) setConfiguredAppId(authSt.appId);
        if (authSt?.redirectUri) setConfiguredRedirectUri(authSt.redirectUri);
      } catch {
        // use configured defaults
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
        window.history.replaceState({}, '', window.location.pathname);
        try {
          const s = await dqiApi.authorizeDerivOAuthAccounts(oauthAccounts);
          setGlobalNotice(
            `Connected ${oauthAccounts.length} Deriv account(s). Active: ${s.activeIsVirtual ? 'DEMO' : 'REAL'} (${s.activeLoginId}).`
          );
        } catch (err) {
          setGlobalNotice(err instanceof Error ? err.message : 'Deriv OAuth authorization failed');
        }
        return;
      }

      const oauthState = params.get('deriv_oauth') || params.get('deriv');
      const oauthErr = params.get('oauth_error');
      if (oauthErr) {
        setGlobalNotice(`Deriv OAuth notice: ${oauthErr}`);
        window.history.replaceState({}, '', window.location.pathname);
      } else if (oauthState === 'connected') {
        window.history.replaceState({}, '', window.location.pathname);
      }

      const restored = await dqiApi.restoreDerivOAuthSession();
      if (restored?.connected && oauthState === 'connected') {
        setGlobalNotice(
          `Connected via Deriv App ${restored.appId}. Active: ${restored.activeIsVirtual ? 'DEMO' : 'REAL'} (${restored.activeLoginId}).`
        );
      }
    })();
  }, []);

  const loadSymbols = useCallback(async (refresh = false) => {
    setSymbolsError(null);
    try {
      const res = await dqiApi.getSymbols(refresh);
      const list = res.symbols || [];
      setSymbols(list);
    } catch (err) {
      setSymbolsError(err instanceof Error ? err.message : 'Unable to load Deriv active symbols');
    }
  }, []);

  const refreshSystemState = useCallback(async () => {
    try {
      const acct = await dqiApi.getPaperAccount();
      setPaperAccount(acct);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void loadSymbols(false);
    void refreshSystemState();
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
          const ordered = [...ticks].slice(-500);
          setLiveTapeBuffer(ordered);
          setLatestTick(ordered[ordered.length - 1]);
          setFeedHealth({ state: 'LIVE', isStale: false, ageSeconds: 0 });
        }
      },
      onTick: (tick) => {
        setLatestTick(tick);
        setLiveTapeBuffer((prev) => [...prev.slice(-499), tick]);
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
    const raw = tokenInput.trim();
    if (!raw) return;
    setConnectBusy(true);
    setConnectErr(null);
    try {

      // Support pasting full OAuth redirect URL (?acct1=...&token1=...)
      if (raw.includes('acct1=') && raw.includes('token1=')) {
        const queryPart = raw.includes('?') ? raw.split('?')[1] : raw;
        const p = new URLSearchParams(queryPart);
        const entries: Array<{ loginid: string; token: string; currency?: string }> = [];
        for (let i = 1; i <= 10; i += 1) {
          const acct = p.get(`acct${i}`);
          const tok = p.get(`token${i}`);
          const cur = p.get(`cur${i}`) ?? undefined;
          if (acct && tok) entries.push({ loginid: acct, token: tok, currency: cur });
        }
        if (entries.length === 0) throw new Error('Could not find account tokens in pasted URL.');
        const s = await dqiApi.authorizeDerivOAuthAccounts(entries);
        setTokenInput('');
        setConnectOpen(false);
        setGlobalNotice(
          `Connected ${entries.length} Deriv account(s). Active: ${s.activeIsVirtual ? 'DEMO' : 'REAL'} (${s.activeLoginId}).`
        );
        return;
      }

      const s = await dqiApi.authorizeDerivToken(raw);
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

  const handleSwitchAccount = async (loginid: string) => {
    const target = derivSession.accounts.find((a) => a.loginid === loginid);
    if (!target) return;
    if (!target.hasToken) {
      setConnectOpen(true);
      setConnectErr(
        `Enter an API token for ${loginid} (or sign in with Deriv OAuth) so both Demo and Real accounts can switch in 1 tap.`
      );
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

  // Periodically refresh all linked Demo + Real Deriv balances when connected
  useEffect(() => {
    if (!derivSession.connected) return;
    void dqiApi.refreshDerivBalances();
    const timer = window.setInterval(() => {
      void dqiApi.refreshDerivBalances();
    }, 20000);
    return () => window.clearInterval(timer);
  }, [derivSession.connected]);

  // Pick primary Demo (VRTC) and primary Real (CR/MF) accounts for the top bar
  const demoAccount = useMemo(() => {
    const virtuals = derivSession.accounts.filter((a) => a.isVirtual);
    return (
      virtuals.find((a) => a.currency === 'USD' && a.balance !== null) ||
      virtuals.find((a) => a.balance !== null) ||
      virtuals[0] ||
      null
    );
  }, [derivSession.accounts]);

  const realAccount = useMemo(() => {
    const reals = derivSession.accounts.filter((a) => !a.isVirtual);
    return (
      reals.find((a) => a.hasToken && a.currency === 'USD' && a.balance !== null) ||
      reals.find((a) => a.currency === 'USD' && a.balance !== null) ||
      reals.find((a) => a.balance !== null && a.balance > 0) ||
      reals.find((a) => a.balance !== null) ||
      reals[0] ||
      null
    );
  }, [derivSession.accounts]);

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#20242B] antialiased dark:bg-[#0D131A] dark:text-[#F3F4F6]">
      {/* Clean 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 border-b border-[#E5E9EF] bg-white px-4 py-2.5 dark:border-[#243040] dark:bg-[#151D27]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          {/* Zone 1: Brand Wordmark */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#FF444F] text-white">
              <BarChart3 className="h-4 w-4" />
            </div>
            <span className="whitespace-nowrap text-sm font-bold tracking-tight text-[#20242B] dark:text-white">
              Deriv Quant
            </span>
          </div>

          {/* Zone 2: 4 Clean Single-Line Nav Tabs */}
          <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Workspace navigation">
            {NAV_TABS.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`whitespace-nowrap shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? 'bg-[#0866FF] text-white'
                      : 'text-[#6B7280] hover:bg-[#F5F7FA] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:bg-[#0F151D] dark:hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Live Feed + Demo & Real Balances + Connect / Theme */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden items-center gap-1.5 px-2 py-1 text-xs text-[#6B7280] dark:text-[#9CA3AF] sm:flex">
              <Activity
                className={`h-3.5 w-3.5 ${
                  feedHealth.state === 'LIVE' && !feedHealth.isStale
                    ? 'text-[#00A88F]'
                    : 'text-[#FFAD3A]'
                }`}
              />
              <span className="font-mono text-[11px] font-semibold">{feedHealth.state}</span>
            </div>

            {derivSession.connected ? (
              <div className="flex items-center gap-1 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-1 dark:border-[#243040] dark:bg-[#0F151D]">
                {demoAccount && (
                  <button
                    type="button"
                    onClick={() => void handleSwitchAccount(demoAccount.loginid)}
                    title={`Demo Account (${demoAccount.loginid})`}
                    className={`whitespace-nowrap shrink-0 rounded px-2.5 py-1 font-mono text-xs font-bold tabular-nums transition ${
                      derivSession.activeIsVirtual
                        ? 'bg-[#00A88F] text-white'
                        : 'text-[#6B7280] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:text-white'
                    }`}
                  >
                    Demo{' '}
                    {demoAccount.balance !== null
                      ? demoAccount.currency === 'USD'
                        ? `$${demoAccount.balance.toFixed(2)}`
                        : `${demoAccount.balance.toFixed(2)} ${demoAccount.currency}`
                      : demoAccount.loginid}
                  </button>
                )}

                {realAccount ? (
                  <button
                    type="button"
                    onClick={() => void handleSwitchAccount(realAccount.loginid)}
                    title={`Real Account (${realAccount.loginid})`}
                    className={`whitespace-nowrap shrink-0 rounded px-2.5 py-1 font-mono text-xs font-bold tabular-nums transition ${
                      !derivSession.activeIsVirtual
                        ? 'bg-[#FF444F] text-white'
                        : 'text-[#6B7280] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:text-white'
                    }`}
                  >
                    Real{' '}
                    {realAccount.balance !== null
                      ? realAccount.currency === 'USD'
                        ? `$${realAccount.balance.toFixed(2)}`
                        : `${realAccount.balance.toFixed(2)} ${realAccount.currency}`
                      : realAccount.loginid}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConnectOpen(true)}
                    className="whitespace-nowrap shrink-0 rounded px-2.5 py-1 text-xs font-semibold text-[#6B7280] hover:text-[#20242B] dark:text-[#9CA3AF] dark:hover:text-white"
                  >
                    + Link Real
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                className="whitespace-nowrap shrink-0 rounded-md bg-[#0866FF] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#0654d4]"
              >
                Connect Deriv
              </button>
            )}

            <button
              type="button"
              onClick={() => setDarkMode((v) => !v)}
              aria-label="Toggle color theme"
              className="rounded-md border border-[#E5E9EF] bg-[#F5F7FA] p-1.5 text-[#20242B] hover:bg-[#EAEFF5] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]"
            >
              {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      {globalNotice && (
        <div className="mx-auto mt-3 flex max-w-7xl items-center justify-between gap-3 rounded-md border border-[#0866FF]/30 bg-[#0866FF]/10 px-4 py-2 text-xs text-[#20242B] dark:text-[#F3F4F6]">
          <span>{globalNotice}</span>
          <button type="button" onClick={() => setGlobalNotice(null)} className="font-semibold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="mx-auto max-w-7xl p-4">
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

        {activeTab === 'risk' && (
          <RiskAccountsWorkspace
            paperAccount={paperAccount}
            derivSession={derivSession}
            onRefreshSystem={() => void refreshSystemState()}
          />
        )}
      </main>

      {/* Connect Deriv Modal (Auto-OAuth + Instant API Token) */}
      {connectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-[#E5E9EF] bg-white p-5 dark:border-[#243040] dark:bg-[#151D27]">
            <div className="flex items-center justify-between border-b border-[#E5E9EF] pb-3 dark:border-[#243040]">
              <h2 className="text-sm font-bold text-[#20242B] dark:text-white">
                Connect Deriv Account
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
                  1. Sign in with Deriv (Loads Demo + Real Balances)
                </div>
                <p className="mt-1 text-[#6B7280] dark:text-[#9CA3AF]">
                  Authenticates through your Deriv App so all Demo and Real trades route through your app ID.
                </p>

                <div className="mt-2.5 space-y-1 rounded-md border border-[#E5E9EF] bg-[#F5F7FA] px-3 py-2 font-mono text-[11px] text-[#20242B] dark:border-[#243040] dark:bg-[#0F151D] dark:text-[#F3F4F6]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#6B7280] dark:text-[#9CA3AF]">App ID</span>
                    <span className="font-bold text-[#0866FF]">{configuredAppId}</span>
                  </div>
                  <div className="truncate text-[10px] text-[#6B7280] dark:text-[#9CA3AF]" title={configuredRedirectUri}>
                    Callback: {configuredRedirectUri}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={connectBusy}
                  onClick={handleOAuthLogin}
                  className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md bg-[#0866FF] px-4 py-2 font-semibold text-white hover:bg-[#0654d4] disabled:opacity-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Continue with Deriv OAuth
                </button>

                <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280] dark:text-[#9CA3AF]">
                  <span>New to Deriv?</span>
                  <a
                    href={`https://deriv.com/?app_id=${configuredAppId}&l=EN&brand=deriv`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-[#0866FF] hover:underline"
                  >
                    Create Deriv Account
                  </a>
                </div>
              </div>

              <div className="border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
                <div className="font-semibold text-[#20242B] dark:text-white">
                  2. Or Connect Instantly with API Token
                </div>
                <p className="mt-1 text-[#6B7280] dark:text-[#9CA3AF]">
                  Paste a Deriv Personal Access Token (PAT) or API Token to load Demo and Real balances.
                </p>
                <form onSubmit={handleTokenLogin} className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste Deriv API Token"
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

              {derivSession.connected && (
                <div className="flex items-center justify-between border-t border-[#E5E9EF] pt-3 dark:border-[#243040]">
                  <span className="text-[#6B7280] dark:text-[#9CA3AF]">
                    Connected as {derivSession.activeLoginId}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      dqiApi.disconnectDeriv();
                      setConnectOpen(false);
                    }}
                    className="font-semibold text-[#FF444F] hover:underline"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
