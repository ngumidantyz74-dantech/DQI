import { useCallback, useEffect, useMemo, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { BotLibrary } from './components/BotLibrary';
import { CsvAnalytics } from './components/CsvAnalytics';
import { DerivAuthModal } from './components/DerivAuthModal';
import { StrategyRunner } from './components/StrategyRunner';
import { AppView, TopBar } from './components/TopBar';
import { VercelDeployView } from './components/VercelDeployView';
import { useBotEngine } from './hooks/useBotEngine';
import { derivService, parseDerivOAuthFromUrl } from './services/derivWs';
import {
  BotStrategyConfig,
  CsvSummaryStats,
  CsvTransaction,
  DerivAccount,
  LiveTick,
} from './types/deriv';
import { parseDerivCsv } from './utils/csvParser';
import { loadPreloadedCsv, loadPreloadedStrategies } from './utils/preloadedAssets';
import { parseDbotXml } from './utils/xmlParser';

export default function App() {
  const [darkMode, setDarkMode] = useState(true);
  const [activeView, setActiveView] = useState<AppView>('runner');
  const [strategies, setStrategies] = useState<BotStrategyConfig[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>('digit-scalper');

  const [csvTransactions, setCsvTransactions] = useState<CsvTransaction[]>([]);
  const [csvStats, setCsvStats] = useState<CsvSummaryStats>({
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    totalVolume: 0,
    netProfit: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdown: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    avgProfitOnWin: 0,
    avgLossOnLoss: 0,
    markets: [],
  });
  const [csvFileName, setCsvFileName] = useState<string>('Transactions_2026-11-22_213354_cde1b4a2.csv');

  const [ticks, setTicks] = useState<LiveTick[]>([]);
  const [feedStatus, setFeedStatus] = useState<'connecting' | 'deriv-ws' | 'local-feed' | 'error'>('connecting');

  const [executionMode, setExecutionMode] = useState<'paper' | 'deriv-live'>('paper');
  const [oauthAccounts, setOauthAccounts] = useState<DerivAccount[]>([]);
  const [activeAccountLoginId, setActiveAccountLoginId] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const selectedStrategy = useMemo(
    () => strategies.find((s) => s.id === selectedStrategyId) || strategies[0] || null,
    [selectedStrategyId, strategies]
  );

  const activeAccount = useMemo(
    () => oauthAccounts.find((a) => a.loginid === activeAccountLoginId) || null,
    [activeAccountLoginId, oauthAccounts]
  );

  const latestTick = ticks.length > 0 ? ticks[ticks.length - 1] : null;

  // Sync Tailwind dark class
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Load preloaded XMLs & CSV on mount
  useEffect(() => {
    loadPreloadedStrategies()
      .then((loaded) => {
        setStrategies(loaded);
        if (loaded.length > 0) {
          setSelectedStrategyId(loaded[0].id);
        }
      })
      .catch(() => {
        // handled silently
      });

    loadPreloadedCsv()
      .then((csvText) => {
        const parsed = parseDerivCsv(csvText);
        setCsvTransactions(parsed.transactions);
        setCsvStats(parsed.stats);
      })
      .catch(() => {
        // handled silently
      });
  }, []);

  // Connect Deriv WebSocket tick feed & listen to status + ticks
  useEffect(() => {
    const unsubStatus = derivService.onStatus((st) => setFeedStatus(st));
    const unsubTick = derivService.onTick((tick) => {
      setTicks((prev) => {
        if (prev.length > 0 && prev[0].symbol !== tick.symbol) {
          return [tick];
        }
        return [...prev.slice(-119), tick];
      });
    });

    derivService.connect();

    return () => {
      unsubStatus();
      unsubTick();
    };
  }, []);

  // Resubscribe when selected strategy symbol changes
  useEffect(() => {
    if (!selectedStrategy) return;
    setTicks([]);
    derivService.subscribeSymbol(selectedStrategy.symbol);
  }, [selectedStrategy?.symbol]);

  // Handle Deriv OAuth callback tokens in URL (?acct1=...&token1=...)
  useEffect(() => {
    const urlAccounts = parseDerivOAuthFromUrl();
    if (urlAccounts.length === 0) return;

    // Clean query string from URL bar
    window.history.replaceState({}, document.title, window.location.pathname);

    const authorizeAll = async () => {
      // Wait briefly for WS open
      const authorized: DerivAccount[] = [];
      for (const acc of urlAccounts) {
        try {
          const auth = await derivService.authorizeAccount(acc.token);
          authorized.push(auth);
        } catch {
          authorized.push({
            loginid: acc.loginid,
            token: acc.token,
            currency: acc.currency,
            balance: 0,
            isVirtual: acc.loginid.startsWith('VRTC'),
          });
        }
      }
      if (authorized.length > 0) {
        setOauthAccounts(authorized);
        setActiveAccountLoginId(authorized[0].loginid);
        setExecutionMode('deriv-live');
      }
    };

    const timer = window.setTimeout(authorizeAll, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSelectOAuthAccount = useCallback(async (loginid: string) => {
    const found = oauthAccounts.find((a) => a.loginid === loginid);
    if (!found) return;
    try {
      const updated = await derivService.authorizeAccount(found.token);
      setOauthAccounts((prev) => prev.map((a) => (a.loginid === loginid ? updated : a)));
    } catch {
      // keep existing
    }
    setActiveAccountLoginId(loginid);
  }, [oauthAccounts]);

  const handleAccountBalanceUpdate = useCallback((newBalance: number) => {
    setOauthAccounts((prev) =>
      prev.map((a) =>
        a.loginid === activeAccountLoginId ? { ...a, balance: newBalance } : a
      )
    );
  }, [activeAccountLoginId]);

  const {
    session,
    trades,
    journal,
    startBot,
    stopBot,
    manualSellAtMarket,
    resetHistory,
  } = useBotEngine(
    selectedStrategy,
    latestTick,
    executionMode,
    activeAccount,
    handleAccountBalanceUpdate
  );

  const handleUpdateStrategy = (updated: BotStrategyConfig) => {
    setStrategies((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  };

  const handleUploadXml = async (file: File) => {
    const text = await file.text();
    const id = `custom-${Date.now()}`;
    const parsed = parseDbotXml(text, {
      id,
      name: file.name.replace(/\.xml$/i, ''),
      fileName: file.name,
    });
    setStrategies((prev) => [...prev, parsed]);
    setSelectedStrategyId(id);
    setActiveView('runner');
  };

  const handleUploadCsv = async (file: File) => {
    const text = await file.text();
    const parsed = parseDerivCsv(text);
    setCsvTransactions(parsed.transactions);
    setCsvStats(parsed.stats);
    setCsvFileName(file.name);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F2F3F4] dark:bg-[#0E0E0E] text-[#0E0E0E] dark:text-[#F2F3F4]">
      <TopBar
        activeView={activeView}
        onNavigate={setActiveView}
        accountLoginId={activeAccount?.loginid || null}
        onOpenConnect={() => setAuthModalOpen(true)}
      />

      {/* Mobile Navigation Tabs */}
      <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-[#E6E9E9] dark:border-[#2A2E30] bg-white dark:bg-[#151717] overflow-x-auto">
        {(
          [
            { id: 'runner', label: 'Bot Runner' },
            { id: 'library', label: 'XML Library' },
            { id: 'analytics', label: 'CSV Analytics' },
            { id: 'deploy', label: 'Vercel Deploy' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveView(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
              activeView === tab.id
                ? 'bg-[#FF444F] text-white'
                : 'text-[#6E757C] dark:text-[#999999]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Workspace Sub-Toolbar: Feed Telemetry, Mode Switcher, Balance, Theme */}
      <div className="border-b border-[#E6E9E9] dark:border-[#2A2E30] bg-white dark:bg-[#151717] px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          {/* Real live streaming feed telemetry */}
          <div className="inline-flex items-center gap-2 text-[#333333] dark:text-[#C2C5C7]">
            <span
              className={`w-2 h-2 rounded-full ${
                feedStatus === 'deriv-ws'
                  ? 'bg-[#4BB4B3]'
                  : feedStatus === 'local-feed'
                    ? 'bg-[#FFAD3A]'
                    : 'bg-[#999999]'
              }`}
            />
            <span>
              {feedStatus === 'deriv-ws'
                ? 'Deriv WebSocket Live'
                : feedStatus === 'local-feed'
                  ? 'Local Synthetic Feed'
                  : 'Connecting Stream...'}
            </span>
          </div>

          <span className="text-[#E6E9E9] dark:text-[#2A2E30]" aria-hidden="true">
            |
          </span>

          {/* Execution Mode Segmented Control */}
          <div className="flex items-center gap-1 p-0.5 rounded bg-[#F2F3F4] dark:bg-[#0E0E0E]">
            <button
              type="button"
              disabled={session.isRunning}
              onClick={() => setExecutionMode('paper')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer disabled:opacity-60 ${
                executionMode === 'paper'
                  ? 'bg-white dark:bg-[#1D1F20] text-[#0E0E0E] dark:text-white'
                  : 'text-[#6E757C] dark:text-[#999999]'
              }`}
            >
              Paper (Live Ticks)
            </button>
            <button
              type="button"
              disabled={session.isRunning}
              onClick={() => {
                if (!activeAccount) {
                  setAuthModalOpen(true);
                } else {
                  setExecutionMode('deriv-live');
                }
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer disabled:opacity-60 ${
                executionMode === 'deriv-live'
                  ? 'bg-white dark:bg-[#1D1F20] text-[#0E0E0E] dark:text-white'
                  : 'text-[#6E757C] dark:text-[#999999]'
              }`}
            >
              Deriv OAuth Account
            </button>
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="font-mono tabular-nums text-xs">
            <span className="text-[#6E757C] dark:text-[#999999] mr-2">
              {executionMode === 'deriv-live' && activeAccount
                ? `${activeAccount.loginid} Balance:`
                : 'Paper Balance:'}
            </span>
            <strong className="text-[#0E0E0E] dark:text-white font-semibold">
              $
              {(executionMode === 'deriv-live' && activeAccount
                ? activeAccount.balance
                : session.paperBalance
              ).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </strong>
          </div>

          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
            className="p-1.5 rounded border border-[#E6E9E9] dark:border-[#2A2E30] text-[#6E757C] dark:text-[#999999] hover:text-[#0E0E0E] dark:hover:text-white cursor-pointer"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 w-full max-w-[1440px] mx-auto p-4 sm:p-6">
        {activeView === 'runner' && (
          <StrategyRunner
            strategies={strategies}
            selectedId={selectedStrategyId}
            onSelectStrategy={setSelectedStrategyId}
            onUpdateStrategy={handleUpdateStrategy}
            onUploadXml={handleUploadXml}
            ticks={ticks}
            session={session}
            trades={trades}
            journal={journal}
            onStart={startBot}
            onStop={stopBot}
            onSellAtMarket={manualSellAtMarket}
            onResetSession={resetHistory}
          />
        )}

        {activeView === 'library' && (
          <BotLibrary
            strategies={strategies}
            selectedId={selectedStrategyId}
            onSelectAndRun={(id) => {
              setSelectedStrategyId(id);
              setActiveView('runner');
            }}
            onUploadXml={handleUploadXml}
          />
        )}

        {activeView === 'analytics' && (
          <CsvAnalytics
            transactions={csvTransactions}
            stats={csvStats}
            csvFileName={csvFileName}
            strategies={strategies}
            onUploadCsv={handleUploadCsv}
          />
        )}

        {activeView === 'deploy' && <VercelDeployView />}
      </main>

      <DerivAuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        accounts={oauthAccounts}
        activeAccount={activeAccount}
        onSelectAccount={handleSelectOAuthAccount}
        onDisconnect={() => {
          setOauthAccounts([]);
          setActiveAccountLoginId(null);
          setExecutionMode('paper');
        }}
      />
    </div>
  );
}
