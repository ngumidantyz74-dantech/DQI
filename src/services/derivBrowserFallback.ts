import type {
  ActiveSymbol,
  CandleBar,
  ContractSupport,
  DerivAccountSummary,
  DerivSessionState,
  LiveDerivContract,
  LiveTickEvent,
} from '../types/dqi';

const DEFAULT_APP_ID =
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DERIV_APP_ID) ||
  '1089';

const SESSION_STORAGE_KEY = 'dqi_deriv_session_tokens_v1';
const PARTNER_CODE_DEFAULT = '352P3WGh6Jm4clLrnbq6u';

interface StoredTokenMap {
  activeLoginId: string | null;
  appId?: string;
  partnerCode?: string;
  tokensByLoginId: Record<string, string>;
}

function extractLastDigitFromQuote(raw: number | string, pipSize: number): {
  rawQuote: string;
  quote: number;
  lastDigit: number;
} {
  const num = typeof raw === 'number' ? raw : Number(raw);
  const formatted = Number.isFinite(num) ? num.toFixed(pipSize) : String(raw);
  const digitsOnly = formatted.replace(/[^0-9]/g, '');
  const lastDigit = digitsOnly.length > 0 ? Number(digitsOnly[digitsOnly.length - 1]) : 0;
  return { rawQuote: formatted, quote: Number.isFinite(num) ? num : 0, lastDigit };
}

class BrowserDerivClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private hostIdx = 0;
  private appId = DEFAULT_APP_ID;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (data: Record<string, unknown>) => void; reject: (err: Error) => void; timer: number }
  >();
  private tickListeners = new Map<string, Set<(tick: LiveTickEvent) => void>>();
  private pipSizeBySymbol = new Map<string, number>();
  private tickBuffers = new Map<string, LiveTickEvent[]>();

  // Authenticated Deriv Account & Real-Time Contract State
  private tokensByLoginId: Record<string, string> = {};
  private sessionState: DerivSessionState = {
    connected: false,
    appId: DEFAULT_APP_ID,
    activeLoginId: null,
    activeIsVirtual: true,
    activeCurrency: 'USD',
    activeBalance: null,
    email: null,
    fullname: null,
    scopes: [],
    accounts: [],
    error: null,
  };
  private sessionListeners = new Set<(state: DerivSessionState) => void>();
  private contractsMap = new Map<number, LiveDerivContract>();
  private contractListeners = new Set<(contracts: LiveDerivContract[]) => void>();
  private balanceSubActive = false;

  private customWsBaseUrl: string | null = null;
  private contractPollTimer: number | null = null;

  constructor() {
    this.restoreFromSessionStorage();
  }

  private wsUrls(): string[] {
    const id = encodeURIComponent(this.appId || '1089');
    const urls = [
      this.customWsBaseUrl
        ? `${this.customWsBaseUrl}${this.customWsBaseUrl.includes('?') ? '&' : '?'}app_id=${id}`
        : null,
      `wss://ws.derivws.com/websockets/v3?app_id=${id}`,
      `wss://frontend.derivws.com/websockets/v3?app_id=${id}`,
      `wss://green.derivws.com/websockets/v3?app_id=${id}`,
      `wss://blue.derivws.com/websockets/v3?app_id=${id}`,
      `wss://red.derivws.com/websockets/v3?app_id=${id}`,
      `wss://ws.binaryws.com/websockets/v3?app_id=${id}`,
    ].filter((u): u is string => Boolean(u));
    return Array.from(new Set(urls));
  }

  public setWsBaseUrl(url: string | null | undefined): void {
    const clean = (url ?? '').trim();
    if (!clean) return;
    if (clean.startsWith('wss://') || clean.startsWith('ws://')) {
      this.customWsBaseUrl = clean.split('?')[0];
    }
  }

  public setAppId(nextAppId: string, persist = false): void {
    const clean = nextAppId.trim();
    if (!/^\d+$/.test(clean) || clean === this.appId) return;
    this.appId = clean;
    this.sessionState = { ...this.sessionState, appId: clean };
    this.connecting = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (persist) {
      this.saveToSessionStorage();
    }
    this.emitSession();
  }

  public getAppId(): string {
    return this.appId;
  }

  private saveToSessionStorage(): void {
    try {
      if (typeof window === 'undefined') return;
      const payload: StoredTokenMap = {
        activeLoginId: this.sessionState.activeLoginId,
        appId: this.appId,
        partnerCode: PARTNER_CODE_DEFAULT,
        tokensByLoginId: this.tokensByLoginId,
      };
      const serialized = JSON.stringify(payload);
      window.localStorage.setItem(SESSION_STORAGE_KEY, serialized);
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, serialized);
    } catch {
      // ignore storage quota errors
    }
  }

  private restoreFromSessionStorage(): void {
    try {
      if (typeof window === 'undefined') return;
      const raw =
        window.localStorage.getItem(SESSION_STORAGE_KEY) ||
        window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredTokenMap;
      if (parsed.appId && /^\d+$/.test(parsed.appId)) {
        this.appId = parsed.appId;
        this.sessionState = { ...this.sessionState, appId: parsed.appId };
      }
      if (parsed.tokensByLoginId && Object.keys(parsed.tokensByLoginId).length > 0) {
        this.tokensByLoginId = parsed.tokensByLoginId;
        const preferred =
          (parsed.activeLoginId && parsed.tokensByLoginId[parsed.activeLoginId] ? parsed.activeLoginId : null) ||
          Object.keys(parsed.tokensByLoginId).find((id) => id.startsWith('VRTC')) ||
          Object.keys(parsed.tokensByLoginId)[0];
        if (preferred) {
          void this.authorizeToken(this.tokensByLoginId[preferred], { skipSave: true }).catch(() => {
            // keep clean unauthenticated state if stored token expired
          });
        }
      }
    } catch {
      // ignore
    }
  }

  private emitSession(): void {
    const snapshot: DerivSessionState = {
      ...this.sessionState,
      accounts: [...this.sessionState.accounts],
    };
    for (const cb of this.sessionListeners) cb(snapshot);
  }

  private emitContracts(): void {
    const list = Array.from(this.contractsMap.values()).sort((a, b) => b.dateStart - a.dateStart);
    for (const cb of this.contractListeners) cb(list);
  }

  public getSessionState(): DerivSessionState {
    return { ...this.sessionState, accounts: [...this.sessionState.accounts] };
  }

  public subscribeSession(cb: (state: DerivSessionState) => void): () => void {
    this.sessionListeners.add(cb);
    cb(this.getSessionState());
    return () => {
      this.sessionListeners.delete(cb);
    };
  }

  public getContracts(): LiveDerivContract[] {
    return Array.from(this.contractsMap.values()).sort((a, b) => b.dateStart - a.dateStart);
  }

  public subscribeContracts(cb: (contracts: LiveDerivContract[]) => void): () => void {
    this.contractListeners.add(cb);
    cb(this.getContracts());
    return () => {
      this.contractListeners.delete(cb);
    };
  }

  private async ensureWs(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const hosts = this.wsUrls();
      let lastErr: Error | null = null;
      for (let i = 0; i < hosts.length; i += 1) {
        const idx = (this.hostIdx + i) % hosts.length;
        const url = hosts[idx];
        try {
          const ws = await new Promise<WebSocket>((resolve, reject) => {
            let settled = false;
            const socket = new WebSocket(url);
            const t = window.setTimeout(() => {
              if (settled) return;
              settled = true;
              try {
                socket.close();
              } catch {
                // ignore
              }
              reject(new Error(`Deriv WebSocket timed out (${new URL(url).host})`));
            }, 3500);

            socket.onopen = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(t);
              resolve(socket);
            };
            socket.onerror = () => {
              if (settled) return;
              settled = true;
              window.clearTimeout(t);
              reject(new Error(`Deriv WebSocket failed (${new URL(url).host})`));
            };
            socket.onclose = (ev) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(t);
              reject(new Error(`Deriv WebSocket closed (${ev.code})`));
            };
          });

          this.hostIdx = idx;
          this.ws = ws;
          this.balanceSubActive = false;
          ws.onmessage = (ev) => this.handleMessage(String(ev.data));
          ws.onclose = () => {
            this.ws = null;
            this.balanceSubActive = false;
            for (const [id, entry] of this.pending.entries()) {
              window.clearTimeout(entry.timer);
              entry.reject(new Error('Deriv WebSocket closed'));
              this.pending.delete(id);
            }
          };

          // Re-authorize active token on reconnect
          const activeToken =
            this.sessionState.activeLoginId && this.tokensByLoginId[this.sessionState.activeLoginId];
          if (activeToken) {
            void this.authorizeToken(activeToken, { skipSave: true }).catch(() => {
              // ignore reconnect auth error
            });
          }

          // Re-subscribe active tick listeners
          for (const sym of this.tickListeners.keys()) {
            ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
          }

          return ws;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      throw lastErr || new Error('Unable to connect to Deriv WebSocket');
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = typeof msg.req_id === 'number' ? msg.req_id : null;
    if (reqId !== null && this.pending.has(reqId)) {
      const entry = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      window.clearTimeout(entry.timer);
      const errObj = msg.error as { message?: string } | undefined;
      if (errObj?.message) {
        entry.reject(new Error(errObj.message));
      } else {
        entry.resolve(msg);
      }
    }

    // 1. Live Tick Stream
    const tick = msg.tick as
      | { symbol?: string; epoch?: number; quote?: number; pip_size?: number }
      | undefined;
    if (tick?.symbol && tick.quote !== undefined && tick.epoch !== undefined) {
      const pipSize =
        typeof tick.pip_size === 'number'
          ? tick.pip_size
          : this.pipSizeBySymbol.get(tick.symbol) ?? 2;
      this.pipSizeBySymbol.set(tick.symbol, pipSize);
      const parsed = extractLastDigitFromQuote(tick.quote, pipSize);
      const evt: LiveTickEvent = {
        symbol: tick.symbol,
        epoch: tick.epoch,
        rawQuote: parsed.rawQuote,
        quote: parsed.quote,
        pipSize,
        lastDigit: parsed.lastDigit,
        receivedAt: new Date(tick.epoch * 1000).toISOString(),
        source: 'DERIV_BROWSER_WS',
      };
      const buf = this.tickBuffers.get(tick.symbol) ?? [];
      buf.push(evt);
      if (buf.length > 1000) buf.splice(0, buf.length - 1000);
      this.tickBuffers.set(tick.symbol, buf);

      const subs = this.tickListeners.get(tick.symbol);
      if (subs) {
        for (const cb of subs) cb(evt);
      }
    }

    // 2. Live Subscribed Balance Updates (All Demo & Real Accounts)
    const bal = msg.balance as
      | {
          balance?: number;
          currency?: string;
          loginid?: string;
          accounts?: Record<string, { balance?: number; currency?: string; type?: string }>;
        }
      | undefined;
    if (bal) {
      let updated = false;
      const nextAccounts = this.sessionState.accounts.map((acct) => {
        const fromAll = bal.accounts?.[acct.loginid];
        if (fromAll && typeof fromAll.balance === 'number') {
          updated = true;
          return { ...acct, balance: fromAll.balance, currency: fromAll.currency || acct.currency };
        }
        if (bal.loginid === acct.loginid && typeof bal.balance === 'number') {
          updated = true;
          return { ...acct, balance: bal.balance, currency: bal.currency || acct.currency };
        }
        return acct;
      });

      const activeMatch = nextAccounts.find((a) => a.loginid === this.sessionState.activeLoginId);
      const nextActiveBal =
        bal.loginid === this.sessionState.activeLoginId && typeof bal.balance === 'number'
          ? bal.balance
          : activeMatch?.balance ?? this.sessionState.activeBalance;

      if (updated || typeof nextActiveBal === 'number') {
        this.sessionState = {
          ...this.sessionState,
          activeBalance: nextActiveBal,
          accounts: nextAccounts,
        };
        this.emitSession();
      }
    }

    // 3. Real-Time Live Open Contract Updates (proposal_open_contract)
    const poc = msg.proposal_open_contract as
      | {
          contract_id?: number;
          underlying?: string;
          contract_type?: string;
          longcode?: string;
          currency?: string;
          buy_price?: number;
          payout?: number;
          bid_price?: number;
          profit?: number;
          profit_percentage?: number;
          entry_spot_display_value?: string;
          entry_spot?: number;
          current_spot_display_value?: string;
          current_spot?: number;
          barrier?: string;
          is_sold?: number;
          is_expired?: number;
          status?: 'open' | 'won' | 'lost' | 'sold';
          date_start?: number;
          date_expiry?: number;
          tick_count?: number;
          account_id?: number;
        }
      | undefined;
    if (poc?.contract_id) {
      const existing = this.contractsMap.get(poc.contract_id);
      const contract: LiveDerivContract = {
        contractId: poc.contract_id,
        symbol: String(poc.underlying || existing?.symbol || ''),
        contractType: String(poc.contract_type || existing?.contractType || ''),
        longcode: String(poc.longcode || existing?.longcode || ''),
        currency: String(poc.currency || existing?.currency || this.sessionState.activeCurrency || 'USD'),
        buyPrice: Number(poc.buy_price ?? existing?.buyPrice ?? 0),
        payout: Number(poc.payout ?? existing?.payout ?? 0),
        bidPrice: Number(poc.bid_price ?? existing?.bidPrice ?? 0),
        profit: Number(poc.profit ?? existing?.profit ?? 0),
        profitPct: Number(poc.profit_percentage ?? existing?.profitPct ?? 0),
        entrySpot: poc.entry_spot_display_value ?? (poc.entry_spot !== undefined ? String(poc.entry_spot) : existing?.entrySpot ?? null),
        currentSpot:
          poc.current_spot_display_value ??
          (poc.current_spot !== undefined ? String(poc.current_spot) : existing?.currentSpot ?? null),
        barrier: poc.barrier ?? existing?.barrier ?? null,
        isSold: Boolean(poc.is_sold),
        isExpired: Boolean(poc.is_expired),
        status: poc.status || existing?.status || 'open',
        dateStart: Number(poc.date_start ?? existing?.dateStart ?? Math.floor(Date.now() / 1000)),
        dateExpiry: poc.date_expiry ?? existing?.dateExpiry ?? null,
        tickCount: poc.tick_count ?? existing?.tickCount ?? null,
        isVirtual: existing?.isVirtual ?? this.sessionState.activeIsVirtual,
        loginid: existing?.loginid ?? this.sessionState.activeLoginId ?? '',
      };
      this.contractsMap.set(poc.contract_id, contract);
      this.emitContracts();
    }
  }

  private async requestViaProxy(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const activeToken =
      this.sessionState.activeLoginId && this.tokensByLoginId[this.sessionState.activeLoginId]
        ? this.tokensByLoginId[this.sessionState.activeLoginId]
        : undefined;
    const needsAuth =
      'balance' in payload ||
      'portfolio' in payload ||
      'proposal_open_contract' in payload ||
      'buy' in payload ||
      'sell' in payload;
    const res = await fetch('/api/v1/deriv/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        appId: /^\d+$/.test(this.appId) ? this.appId : '1089',
        token: needsAuth ? activeToken : undefined,
        payload,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(body.error || `Deriv proxy failed (HTTP ${res.status})`));
    }
    this.handleMessage(JSON.stringify(body));
    return body;
  }

  private async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const ws = await this.ensureWs();
      const id = this.reqId++;
      return await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Deriv request timed out'));
        }, 12_000);
        this.pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ ...payload, req_id: id }));
      });
    } catch (wsErr) {
      // Fall back transparently to stateless HTTPS proxy when browser WS is blocked
      try {
        return await this.requestViaProxy(payload);
      } catch (proxyErr) {
        const wsMsg = wsErr instanceof Error ? wsErr.message : 'WebSocket failed';
        const pxMsg = proxyErr instanceof Error ? proxyErr.message : 'Proxy failed';
        throw new Error(`${wsMsg} · Fallback: ${pxMsg}`);
      }
    }
  }

  // ---------------- AUTHENTICATION (DERIV OAUTH & API TOKEN) ----------------

  public async authorizeOAuthAccounts(entries: Array<{ loginid: string; token: string; currency?: string }>): Promise<DerivSessionState> {
    for (const item of entries) {
      if (item.loginid && item.token) {
        this.tokensByLoginId[item.loginid] = item.token;
      }
    }
    // Always start safely on Demo (VRTC...) if present
    const defaultEntry = entries.find((e) => e.loginid.startsWith('VRTC')) || entries[0];
    if (!defaultEntry) {
      throw new Error('No Deriv accounts received from OAuth redirect');
    }
    return this.authorizeToken(defaultEntry.token);
  }

  public async authorizeToken(token: string, opts?: { skipSave?: boolean }): Promise<DerivSessionState> {
    const cleanToken = token.trim();
    if (!cleanToken) throw new Error('API token cannot be empty');

    const res = await this.request({ authorize: cleanToken });
    const auth = res.authorize as {
      loginid: string;
      balance: number;
      currency: string;
      email?: string;
      fullname?: string;
      is_virtual: number;
      scopes?: string[];
      account_list?: Array<{
        loginid: string;
        currency: string;
        is_virtual: number;
        account_category?: string;
        is_disabled?: number;
      }>;
    };

    if (!auth?.loginid) {
      throw new Error('Deriv authorization returned invalid account payload');
    }

    this.tokensByLoginId[auth.loginid] = cleanToken;

    const existingBalMap = new Map(this.sessionState.accounts.map((a) => [a.loginid, a.balance]));
    const accounts: DerivAccountSummary[] = (auth.account_list || [])
      .filter((a) => !a.is_disabled)
      .map((a) => ({
        loginid: a.loginid,
        currency: a.currency || 'USD',
        isVirtual: Boolean(a.is_virtual),
        balance: a.loginid === auth.loginid ? Number(auth.balance) : existingBalMap.get(a.loginid) ?? null,
        hasToken: Boolean(this.tokensByLoginId[a.loginid]),
        accountCategory: a.account_category,
      }));

    if (!accounts.some((a) => a.loginid === auth.loginid)) {
      accounts.unshift({
        loginid: auth.loginid,
        currency: auth.currency || 'USD',
        isVirtual: Boolean(auth.is_virtual),
        balance: Number(auth.balance),
        hasToken: true,
      });
    }

    this.sessionState = {
      connected: true,
      appId: this.appId,
      activeLoginId: auth.loginid,
      activeIsVirtual: Boolean(auth.is_virtual),
      activeCurrency: auth.currency || 'USD',
      activeBalance: Number(auth.balance),
      email: auth.email || null,
      fullname: auth.fullname || null,
      scopes: auth.scopes || [],
      accounts,
      error: null,
    };

    if (!opts?.skipSave) {
      this.saveToSessionStorage();
    }
    this.emitSession();

    // Subscribe to live balance updates across ALL linked Demo & Real accounts
    try {
      if (!this.balanceSubActive) {
        this.balanceSubActive = true;
        await this.request({ balance: 1, account: 'all', subscribe: 1 });
      } else {
        await this.request({ balance: 1, account: 'all' });
      }
    } catch {
      // Fallback single-account balance subscription
      try {
        await this.request({ balance: 1, subscribe: 1 });
      } catch {
        // ignore non-fatal balance stream error
      }
    }

    // Load any currently open contracts on this Deriv account
    try {
      const portfolio = await this.request({ portfolio: 1 });
      const list = (portfolio.portfolio as { contracts?: Array<{ contract_id: number }> })?.contracts || [];
      for (const c of list.slice(0, 10)) {
        if (c.contract_id) {
          void this.request({ proposal_open_contract: 1, contract_id: c.contract_id, subscribe: 1 }).catch(() => {});
        }
      }
    } catch {
      // ignore if portfolio empty or read restricted
    }

    return this.getSessionState();
  }

  public async switchAccount(loginid: string): Promise<DerivSessionState> {
    const token = this.tokensByLoginId[loginid];
    if (!token) {
      throw new Error(
        `No API token stored for ${loginid}. Connect via Deriv OAuth or enter a token generated for ${loginid} on app.deriv.com/account/api-token.`
      );
    }
    return this.authorizeToken(token);
  }

  public disconnectSession(): void {
    this.tokensByLoginId = {};
    this.contractsMap.clear();
    this.balanceSubActive = false;
    this.sessionState = {
      connected: false,
      appId: this.appId,
      activeLoginId: null,
      activeIsVirtual: true,
      activeCurrency: 'USD',
      activeBalance: null,
      email: null,
      fullname: null,
      scopes: [],
      accounts: [],
      error: null,
    };
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
      this.ws?.send(JSON.stringify({ logout: 1 }));
    } catch {
      // ignore
    }
    this.emitContracts();
    this.emitSession();
  }

  // ---------------- LIVE REAL / DEMO TRADING & PROPOSAL STREAMING ----------------

  public async buyContract(payload: {
    symbol: string;
    contractType: string;
    amount: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    barrier?: string;
  }): Promise<LiveDerivContract> {
    if (!this.sessionState.connected || !this.sessionState.activeLoginId) {
      throw new Error('Connect your Deriv Demo or Real account first.');
    }

    const currency = this.sessionState.activeCurrency || 'USD';
    const parameters: Record<string, unknown> = {
      amount: payload.amount,
      basis: 'stake',
      contract_type: payload.contractType,
      currency,
      duration: payload.duration,
      duration_unit: payload.durationUnit,
      symbol: payload.symbol,
    };
    if (payload.barrier !== undefined && payload.barrier !== '') {
      parameters.barrier = payload.barrier;
    }

    const res = await this.request({
      buy: 1,
      price: payload.amount,
      parameters,
    });

    const buy = res.buy as {
      contract_id: number;
      buy_price: number;
      payout: number;
      longcode: string;
      balance_after: number;
      start_time: number;
    };

    const initialContract: LiveDerivContract = {
      contractId: buy.contract_id,
      symbol: payload.symbol,
      contractType: payload.contractType,
      longcode: buy.longcode || `${payload.contractType} ${payload.symbol}`,
      currency,
      buyPrice: Number(buy.buy_price),
      payout: Number(buy.payout),
      bidPrice: Number(buy.buy_price),
      profit: 0,
      profitPct: 0,
      entrySpot: null,
      currentSpot: null,
      barrier: payload.barrier ?? null,
      isSold: false,
      isExpired: false,
      status: 'open',
      dateStart: Number(buy.start_time || Math.floor(Date.now() / 1000)),
      dateExpiry: null,
      tickCount: payload.durationUnit === 't' ? payload.duration : null,
      isVirtual: this.sessionState.activeIsVirtual,
      loginid: this.sessionState.activeLoginId,
    };

    this.contractsMap.set(buy.contract_id, initialContract);
    if (typeof buy.balance_after === 'number') {
      this.sessionState = {
        ...this.sessionState,
        activeBalance: Number(buy.balance_after),
        accounts: this.sessionState.accounts.map((a) =>
          a.loginid === this.sessionState.activeLoginId ? { ...a, balance: Number(buy.balance_after) } : a
        ),
      };
      this.emitSession();
    }
    this.emitContracts();

    // Subscribe to real-time tick-by-tick P&L calculation (proposal_open_contract)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      void this.request({
        proposal_open_contract: 1,
        contract_id: buy.contract_id,
        subscribe: 1,
      }).catch(() => {});
    } else {
      // Poll live P&L over HTTPS proxy when WS isn't open
      this.ensureContractProxyPolling();
    }

    return initialContract;
  }

  private ensureContractProxyPolling(): void {
    if (this.contractPollTimer !== null) return;
    this.contractPollTimer = window.setInterval(() => {
      const openList = Array.from(this.contractsMap.values()).filter((c) => !c.isSold && !c.isExpired);
      if (openList.length === 0 || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
        if (this.contractPollTimer !== null) {
          window.clearInterval(this.contractPollTimer);
          this.contractPollTimer = null;
        }
        return;
      }
      for (const c of openList.slice(0, 6)) {
        void this.requestViaProxy({ proposal_open_contract: 1, contract_id: c.contractId }).catch(() => {});
      }
    }, 1500);
  }

  public async sellContract(contractId: number): Promise<void> {
    await this.request({ sell: contractId, price: 0 });
    await this.request({ proposal_open_contract: 1, contract_id: contractId }).catch(() => {});
  }

  // ---------------- PUBLIC MARKET DATA ----------------

  async fetchActiveSymbols(): Promise<ActiveSymbol[]> {
    const res = await this.request({ active_symbols: 'brief', product_type: 'basic' });
    const list = (res.active_symbols as ActiveSymbol[] | undefined) ?? [];
    for (const s of list) {
      if (typeof s.pip === 'number' && s.pip > 0) {
        const decimals = Math.max(0, Math.round(-Math.log10(s.pip)));
        this.pipSizeBySymbol.set(s.symbol, decimals);
      }
    }
    return list;
  }

  async fetchContractsFor(symbol: string): Promise<ContractSupport> {
    const res = await this.request({ contracts_for: symbol, currency: 'USD', product_type: 'basic' });
    const available =
      ((res.contracts_for as { available?: Array<{ contract_type?: string }> })?.available) ?? [];
    const supportedTypes = Array.from(new Set(available.map((c) => c.contract_type).filter(Boolean))) as string[];
    const has = (t: string) => supportedTypes.includes(t);
    return {
      symbol,
      supportedTypes,
      supportsDigits: has('DIGITMATCH') || has('DIGITDIFF') || has('DIGITEVEN') || has('DIGITOVER'),
      supportsMatch: has('DIGITMATCH'),
      supportsDiffer: has('DIGITDIFF'),
      supportsOverUnder: has('DIGITOVER') && has('DIGITUNDER'),
      supportsEvenOdd: has('DIGITEVEN') && has('DIGITODD'),
      supportsRiseFall: has('CALL') && has('PUT'),
      minDurationTicks: 1,
      maxDurationTicks: 10,
      checkedAt: new Date().toISOString(),
    };
  }

  async fetchCandles(symbol: string, granularity: number, count: number): Promise<CandleBar[]> {
    const res = await this.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      granularity,
      style: 'candles',
    });
    const raw =
      (res.candles as Array<{
        epoch: number;
        open: string | number;
        high: string | number;
        low: string | number;
        close: string | number;
      }> | undefined) ?? [];
    return raw.map((c) => ({
      epoch: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
  }

  async fetchTickHistory(symbol: string, count: number): Promise<LiveTickEvent[]> {
    const res = await this.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      style: 'ticks',
    });
    const hist = res.history as { prices?: Array<number | string>; times?: number[] } | undefined;
    const pipSize =
      typeof res.pip_size === 'number'
        ? res.pip_size
        : this.pipSizeBySymbol.get(symbol) ?? 2;
    this.pipSizeBySymbol.set(symbol, pipSize);
    const prices = hist?.prices ?? [];
    const times = hist?.times ?? [];
    const out: LiveTickEvent[] = [];
    for (let i = 0; i < prices.length; i += 1) {
      const epoch = Number(times[i] ?? 0);
      const parsed = extractLastDigitFromQuote(prices[i], pipSize);
      out.push({
        symbol,
        epoch,
        rawQuote: parsed.rawQuote,
        quote: parsed.quote,
        pipSize,
        lastDigit: parsed.lastDigit,
        receivedAt: new Date(epoch * 1000).toISOString(),
        source: 'DERIV_BROWSER_WS',
      });
    }
    this.tickBuffers.set(symbol, out);
    return out;
  }

  async fetchProposal(payload: {
    symbol: string;
    contractType: string;
    amount: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    barrier?: string;
  }) {
    const req: Record<string, unknown> = {
      proposal: 1,
      amount: payload.amount,
      basis: 'stake',
      contract_type: payload.contractType,
      currency: this.sessionState.activeCurrency || 'USD',
      duration: payload.duration,
      duration_unit: payload.durationUnit,
      symbol: payload.symbol,
    };
    if (payload.barrier !== undefined && payload.barrier !== '') {
      req.barrier = payload.barrier;
    }
    const res = await this.request(req);
    const prop = res.proposal as { id: string; ask_price: number; payout: number; spot: number; longcode: string };
    const breakEvenProbPct = prop.payout > 0 ? Number(((prop.ask_price / prop.payout) * 100).toFixed(2)) : null;
    return {
      proposalId: prop.id,
      askPrice: Number(prop.ask_price),
      payout: Number(prop.payout),
      spot: Number(prop.spot),
      longcode: prop.longcode,
      breakEvenProbPct,
      fetchedAt: new Date().toISOString(),
    };
  }

  subscribeTicks(
    symbol: string,
    handlers: {
      onReady?: (data: { symbol: string; bufferedCount: number; pipSize: number }) => void;
      onHistory?: (ticks: LiveTickEvent[]) => void;
      onTick?: (tick: LiveTickEvent) => void;
      onHealth?: (health: { connectionState: string; isStale: boolean; ageSeconds: number | null }) => void;
      onError?: (message: string) => void;
    }
  ): () => void {
    let closed = false;
    let set = this.tickListeners.get(symbol);
    if (!set) {
      set = new Set();
      this.tickListeners.set(symbol, set);
    }
    const cb = (t: LiveTickEvent) => {
      if (!closed) handlers.onTick?.(t);
    };
    set.add(cb);

    let pollTimer: number | null = null;
    let retryTimer: number | null = null;
    let lastEpochSent = 0;

    const startProxyPolling = () => {
      if (pollTimer !== null || closed) return;
      pollTimer = window.setInterval(async () => {
        if (closed) return;
        // If WS recovered in the meantime, stop polling
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          if (pollTimer !== null) {
            window.clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }
        try {
          const res = await this.requestViaProxy({ ticks: symbol });
          const t = res.tick as { symbol?: string; epoch?: number; quote?: number; pip_size?: number } | undefined;
          if (t?.quote !== undefined && t.epoch !== undefined && t.epoch !== lastEpochSent) {
            lastEpochSent = t.epoch;
            const pipSize =
              typeof t.pip_size === 'number' ? t.pip_size : this.pipSizeBySymbol.get(symbol) ?? 2;
            this.pipSizeBySymbol.set(symbol, pipSize);
            const parsed = extractLastDigitFromQuote(t.quote, pipSize);
            handlers.onTick?.({
              symbol,
              epoch: t.epoch,
              rawQuote: parsed.rawQuote,
              quote: parsed.quote,
              pipSize,
              lastDigit: parsed.lastDigit,
              receivedAt: new Date(t.epoch * 1000).toISOString(),
              source: 'DERIV_PROXY_LIVE',
            });
            handlers.onHealth?.({ connectionState: 'LIVE', isStale: false, ageSeconds: 0 });
          }
        } catch {
          // keep trying cleanly
        }
      }, 1500);
    };

    const connectStream = async (attempt = 0) => {
      if (closed) return;
      try {
        const history = await this.fetchTickHistory(symbol, 120);
        if (closed) return;
        if (history.length > 0) {
          lastEpochSent = history[history.length - 1].epoch;
          handlers.onReady?.({
            symbol,
            bufferedCount: history.length,
            pipSize: this.pipSizeBySymbol.get(symbol) ?? 2,
          });
          handlers.onHistory?.(history);
        }

        // Try direct WS for millisecond push ticks; fall back to proxy polling if WS blocked
        try {
          const ws = await this.ensureWs();
          if (!closed && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
            handlers.onHealth?.({ connectionState: 'LIVE', isStale: false, ageSeconds: 0 });
            return;
          }
        } catch {
          handlers.onHealth?.({ connectionState: 'LIVE', isStale: false, ageSeconds: 0 });
          startProxyPolling();
          return;
        }
      } catch (err) {
        if (!closed) {
          handlers.onError?.(err instanceof Error ? err.message : 'Deriv WebSocket connection failed');
          const delay = Math.min(15_000, 3_000 * Math.max(1, attempt + 1));
          retryTimer = window.setTimeout(() => void connectStream(attempt + 1), delay);
        }
      }
    };

    void connectStream(0);

    return () => {
      closed = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      const cur = this.tickListeners.get(symbol);
      if (cur) {
        cur.delete(cb);
        if (cur.size === 0) {
          this.tickListeners.delete(symbol);
          try {
            this.ws?.send(JSON.stringify({ forget_all: 'ticks' }));
          } catch {
            // ignore
          }
        }
      }
    };
  }
}

export const browserDerivPublic = new BrowserDerivClient();
