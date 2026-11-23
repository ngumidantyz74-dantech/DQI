import { browserDerivPublic } from './derivBrowserFallback';
import type {
  ActiveSymbol,
  BoundedRecoveryPolicy,
  CandleBar,
  ContractSupport,
  DigitsFullResponse,
  LiveTickEvent,
  PaperAccount,
  PaperPosition,
  PaperStrategy,
  QuantAnalysis,
} from '../types/dqi';

const TF_GRANULARITY: Record<string, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

async function apiFetch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body !== undefined ? 'POST' : 'GET',
    credentials: 'include',
    headers: {
      'X-Requested-With': 'DQI-Client',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }
  return data as T;
}

export const dqiApi = {
  getHealth: () => apiFetch<{
    status: string;
    liveTradingEnabled: boolean;
    recoveryEnabled: boolean;
    derivOAuthConfigured: boolean;
    database: {
      configured: boolean;
      connected: boolean;
      mode: 'NEON_POSTGRES' | 'PREVIEW_MEMORY';
      appliedMigrations: string[];
      availableMigrations: string[];
    };
    marketFeed: {
      connectionState: string;
      isConnected: boolean;
      isStale: boolean;
      ageSeconds: number | null;
    };
  }>('/api/health'),

  getSymbols: async (refresh = false) => {
    try {
      return await apiFetch<{ symbols: ActiveSymbol[]; count: number; source: string; fetchedAt: string }>(
        `/api/v1/markets/symbols${refresh ? '?refresh=true' : ''}`
      );
    } catch {
      const symbols = await browserDerivPublic.fetchActiveSymbols();
      return {
        symbols,
        count: symbols.length,
        source: 'DERIV_BROWSER_WS',
        fetchedAt: new Date().toISOString(),
      };
    }
  },

  getContractsFor: async (symbol: string) => {
    try {
      return await apiFetch<ContractSupport>(`/api/v1/markets/contracts/${encodeURIComponent(symbol)}`);
    } catch {
      return browserDerivPublic.fetchContractsFor(symbol);
    }
  },

  getCandles: async (symbol: string, granularity = 60, count = 200) => {
    try {
      return await apiFetch<{ symbol: string; granularity: number; candles: CandleBar[] }>(
        `/api/v1/markets/history/${encodeURIComponent(symbol)}?style=candles&granularity=${granularity}&count=${count}`
      );
    } catch {
      const candles = await browserDerivPublic.fetchCandles(symbol, granularity, count);
      return { symbol, granularity, candles };
    }
  },

  getProposal: async (payload: {
    symbol: string;
    contractType: string;
    amount: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    barrier?: string;
  }) => {
    try {
      return await apiFetch<{
        proposalId: string;
        askPrice: number;
        payout: number;
        spot: number;
        longcode: string;
        breakEvenProbPct: number | null;
        fetchedAt: string;
      }>('/api/v1/markets/proposal', payload);
    } catch {
      return browserDerivPublic.fetchProposal(payload);
    }
  },

  analyzeDigits: async (symbol: string, window = 100, stake = 1, duration = 1) => {
    try {
      return await apiFetch<DigitsFullResponse>(
        `/api/v1/digits/analyze/${encodeURIComponent(symbol)}?window=${window}&stake=${stake}&duration=${duration}`
      );
    } catch {
      const [ticks, contractSupport] = await Promise.all([
        browserDerivPublic.fetchTickHistory(symbol, Math.max(window, 250)),
        browserDerivPublic.fetchContractsFor(symbol).catch(() => null),
      ]);
      const [matchProp, differProp] = await Promise.all([
        contractSupport?.supportsMatch !== false
          ? browserDerivPublic
              .fetchProposal({ symbol, contractType: 'DIGITMATCH', amount: stake, duration, durationUnit: 't', barrier: '0' })
              .then((p) => ({ askPrice: p.askPrice, payout: p.payout }))
              .catch(() => null)
          : Promise.resolve(null),
        contractSupport?.supportsDiffer !== false
          ? browserDerivPublic
              .fetchProposal({ symbol, contractType: 'DIGITDIFF', amount: stake, duration, durationUnit: 't', barrier: '0' })
              .then((p) => ({ askPrice: p.askPrice, payout: p.payout }))
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      return apiFetch<DigitsFullResponse>('/api/v1/digits/compute', {
        symbol,
        window,
        stake,
        durationTicks: duration,
        ticks,
        contractSupport,
        proposals: { match: matchProp, differ: differProp },
      });
    }
  },

  analyzeQuant: async (symbol: string, timeframe: string, count = 250) => {
    try {
      return await apiFetch<QuantAnalysis>('/api/v1/quant/analyze', { symbol, timeframe, count });
    } catch {
      const candles = await browserDerivPublic.fetchCandles(
        symbol,
        TF_GRANULARITY[timeframe] ?? 900,
        count
      );
      return apiFetch<QuantAnalysis>('/api/v1/quant/compute', { symbol, timeframe, candles });
    }
  },

  analyzeMultiTimeframe: async (symbol: string, timeframes = ['M5', 'M15', 'H1', 'H4']) => {
    try {
      return await apiFetch<{
        symbol: string;
        consensus: 'BUY' | 'SELL' | 'MIXED';
        consensus_score: number;
        alignment: number;
        timeframes: Record<string, QuantAnalysis>;
      }>('/api/v1/quant/multi-timeframe', { symbol, timeframes, count: 200 });
    } catch {
      const entries = await Promise.all(
        timeframes.map(async (tf) => {
          const candles = await browserDerivPublic.fetchCandles(symbol, TF_GRANULARITY[tf] ?? 900, 200);
          const analysis = await apiFetch<QuantAnalysis>('/api/v1/quant/compute', { symbol, timeframe: tf, candles });
          return [tf, analysis] as const;
        })
      );
      const tfMap: Record<string, QuantAnalysis> = {};
      let sumScore = 0;
      let buys = 0;
      let sells = 0;
      for (const [tf, res] of entries) {
        tfMap[tf] = res;
        sumScore += res.score;
        if (res.direction === 'BUY') buys += 1;
        if (res.direction === 'SELL') sells += 1;
      }
      const n = entries.length || 1;
      const consensus: 'BUY' | 'SELL' | 'MIXED' = buys >= Math.ceil(n / 2) + (buys > sells ? 0 : 1)
        ? 'BUY'
        : sells > buys && sells >= Math.ceil(n / 2)
        ? 'SELL'
        : 'MIXED';
      return {
        symbol,
        consensus,
        consensus_score: Number((sumScore / n).toFixed(3)),
        alignment: Math.max(buys, sells) / n,
        timeframes: tfMap,
      };
    }
  },

  scanMarkets: async (symbols: string[], timeframe: string) => {
    try {
      return await apiFetch<{
        scanned: number;
        timeframe: string;
        scannedAt: string;
        results: Array<QuantAnalysis | { symbol: string; direction: 'ERROR'; error: string }>;
      }>('/api/v1/quant/scan', { symbols, timeframe, count: 140 });
    } catch {
      const gran = TF_GRANULARITY[timeframe] ?? 900;
      const results: Array<QuantAnalysis | { symbol: string; direction: 'ERROR'; error: string }> = [];
      for (const sym of symbols) {
        try {
          const candles = await browserDerivPublic.fetchCandles(sym, gran, 140);
          const analysis = await apiFetch<QuantAnalysis>('/api/v1/quant/compute', { symbol: sym, timeframe, candles });
          results.push(analysis);
        } catch (err) {
          results.push({ symbol: sym, direction: 'ERROR', error: err instanceof Error ? err.message : 'Scan failed' });
        }
      }
      results.sort((a, b) => {
        const ca = 'calibrated_confidence' in a ? a.calibrated_confidence : 0;
        const cb = 'calibrated_confidence' in b ? b.calibrated_confidence : 0;
        return cb - ca;
      });
      return { scanned: results.length, timeframe, scannedAt: new Date().toISOString(), results };
    }
  },

  runBacktest: async (payload: {
    symbol: string;
    timeframe: string;
    count: number;
    initial_equity: number;
    risk_fraction: number;
    fee_rate: number;
    slippage_bps: number;
    threshold: number;
  }) => {
    try {
      return await apiFetch<{
        symbol: string;
        timeframe: string;
        metrics: Record<string, number | string | null>;
        equity_curve: number[];
        trades: Array<{ entry_epoch: number; side: string; entry: number; exit: number; pnl: number; regime: string }>;
        disclaimer: string;
      }>('/api/v1/quant/backtest', payload);
    } catch {
      const candles = await browserDerivPublic.fetchCandles(
        payload.symbol,
        TF_GRANULARITY[payload.timeframe] ?? 900,
        payload.count
      );
      return apiFetch<{
        symbol: string;
        timeframe: string;
        metrics: Record<string, number | string | null>;
        equity_curve: number[];
        trades: Array<{ entry_epoch: number; side: string; entry: number; exit: number; pnl: number; regime: string }>;
        disclaimer: string;
      }>('/api/v1/quant/backtest', { ...payload, candles });
    }
  },

  runWalkForward: async (symbol: string, timeframe: string) => {
    try {
      return await apiFetch<{
        symbol: string;
        timeframe: string;
        fold_count: number;
        method: string;
        folds: Array<{
          fold: number;
          selected_threshold: number;
          out_of_sample: Record<string, number | string | null> | null;
        }>;
      }>('/api/v1/quant/walk-forward', { symbol, timeframe, count: 600, train_size: 240, test_size: 80, step: 80 });
    } catch {
      const candles = await browserDerivPublic.fetchCandles(symbol, TF_GRANULARITY[timeframe] ?? 900, 600);
      return apiFetch<{
        symbol: string;
        timeframe: string;
        fold_count: number;
        method: string;
        folds: Array<{
          fold: number;
          selected_threshold: number;
          out_of_sample: Record<string, number | string | null> | null;
        }>;
      }>('/api/v1/quant/walk-forward', {
        symbol,
        timeframe,
        count: 600,
        train_size: 240,
        test_size: 80,
        step: 80,
        candles,
      });
    }
  },

  getPaperAccount: () => apiFetch<PaperAccount>('/api/v1/paper/account'),
  getPaperPositions: () => apiFetch<{ positions: PaperPosition[] }>('/api/v1/paper/positions'),
  openPaperTrade: (payload: {
    symbol: string;
    timeframe: string;
    contractType: string;
    barrier?: string;
    direction: 'BUY' | 'SELL';
    stake: number;
    expiry_seconds: number;
    payout_multiplier: number;
    strategy_id?: number | null;
  }) => apiFetch<{ position: PaperPosition }>('/api/v1/paper/trades', payload),

  settlePaperPosition: (positionId: number) =>
    apiFetch<{ position: PaperPosition; account: PaperAccount }>(`/api/v1/paper/positions/${positionId}/settle`, {}),

  getStrategies: () => apiFetch<{ strategies: PaperStrategy[] }>('/api/v1/paper/strategies'),
  createStrategy: (payload: {
    name: string;
    description: string;
    symbol: string;
    timeframe: string;
    contract_family: string;
    parameters: Record<string, unknown>;
    blocks: Record<string, unknown>;
    enabled: boolean;
    auto_enabled: boolean;
    risk_fraction: number;
    expiry_seconds: number;
    payout_multiplier: number;
    min_confidence: number;
    cooldown_seconds: number;
  }) => apiFetch<{ strategy: PaperStrategy }>('/api/v1/paper/strategies', payload),

  toggleStrategy: (id: number, enabled: boolean, auto_enabled: boolean) =>
    apiFetch<{ strategy: PaperStrategy }>(`/api/v1/automation/strategies/${id}/toggle`, { enabled, auto_enabled }),

  getAutomationStatus: () =>
    apiFetch<{
      control: { enabled: boolean; kill_switch: boolean; paused_reason: string | null; updated_at: string };
      active_strategies: number;
      total_strategies: number;
      alerts: Array<{ alert_id: number; severity: string; alert_code: string; message: string; acknowledged_at: string | null; created_at: string }>;
      unacknowledged_alerts: number;
      last_run_at: string | null;
    }>('/api/v1/automation/status'),

  setAutomationControl: (enabled: boolean, kill_switch: boolean, reason: string) =>
    apiFetch<{ control: { enabled: boolean; kill_switch: boolean; paused_reason: string | null } }>(
      '/api/v1/automation/control',
      { enabled, kill_switch, reason }
    ),

  runAutomationOnce: () =>
    apiFetch<{ executed: number; settled: number; skippedReason?: string }>('/api/v1/automation/run-once', {}),

  acknowledgeAlert: (id: number) => apiFetch(`/api/v1/automation/alerts/${id}/acknowledge`, {}),

  getRecoveryPolicy: () =>
    apiFetch<{
      policy: BoundedRecoveryPolicy;
      worstCaseAdditionalLossPreview: number;
      unlimitedMartingaleAllowed: boolean;
      deploymentRecoveryFlag: boolean;
    }>('/api/v1/risk/recovery'),

  updateRecoveryPolicy: (payload: Partial<BoundedRecoveryPolicy>) =>
    apiFetch<{ policy: BoundedRecoveryPolicy; worstCaseAdditionalLossPreview: number }>('/api/v1/risk/recovery', payload),

  getDerivAuthStatus: () =>
    apiFetch<{ configured: boolean; connected: boolean; message: string }>('/api/v1/auth/deriv/status'),

  startDerivOAuth: () => apiFetch<{ authorizationUrl: string }>('/api/v1/auth/deriv/start'),

  getLiveControl: () =>
    apiFetch<{
      control: {
        live_enabled: boolean;
        kill_switch: boolean;
        require_manual_approval: boolean;
        max_stake: number;
        max_daily_loss: number;
        max_open_contracts: number;
      };
      deployment_gate: boolean;
      max_stake_cap: number;
      max_daily_loss_cap: number;
      intents: Array<Record<string, unknown>>;
    }>('/api/v1/live/control'),

  activateKillSwitch: () => apiFetch('/api/v1/live/kill-switch', {}),

  getQuantSession: () =>
    apiFetch<{ configured: boolean; fromEnv: boolean; authenticated: boolean }>('/api/v1/quant/session'),
  claimQuantAdmin: (password: string) =>
    apiFetch<{ authenticated: boolean; configured: boolean }>('/api/v1/quant/auth/claim', { password }),
  loginQuantAdmin: (password: string) =>
    apiFetch<{ authenticated: boolean }>('/api/v1/quant/auth/login', { password }),
  logoutQuantAdmin: () => apiFetch<{ authenticated: boolean }>('/api/v1/quant/auth/logout', {}),

  runMigrations: () => apiFetch<{ ok: boolean; applied: string[]; skipped: string[] }>('/api/v1/system/migrate', {}),

  subscribeLiveStream: (
    symbol: string,
    handlers: {
      onReady?: (data: { symbol: string; bufferedCount: number; pipSize: number }) => void;
      onHistory?: (ticks: LiveTickEvent[]) => void;
      onTick?: (tick: LiveTickEvent) => void;
      onHealth?: (health: { connectionState: string; isStale: boolean; ageSeconds: number | null }) => void;
      onError?: (message: string) => void;
    }
  ): (() => void) => {
    let fallbackUnsub: (() => void) | null = null;
    let switchedToFallback = false;
    const es = new EventSource(`/api/v1/markets/stream?symbol=${encodeURIComponent(symbol)}`);

    const activateBrowserFallback = () => {
      if (switchedToFallback) return;
      switchedToFallback = true;
      es.close();
      fallbackUnsub = browserDerivPublic.subscribeTicks(symbol, handlers);
    };

    es.addEventListener('ready', (ev) => {
      try {
        handlers.onReady?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        // ignore
      }
    });
    es.addEventListener('history', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        handlers.onHistory?.(data.ticks || []);
      } catch {
        // ignore
      }
    });
    es.addEventListener('tick', (ev) => {
      try {
        handlers.onTick?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        // ignore
      }
    });
    es.addEventListener('health', (ev) => {
      try {
        handlers.onHealth?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        // ignore
      }
    });
    es.addEventListener('feed_error', () => {
      activateBrowserFallback();
    });
    es.onerror = () => {
      activateBrowserFallback();
    };
    return () => {
      es.close();
      fallbackUnsub?.();
    };
  },
};
