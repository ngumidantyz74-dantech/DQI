import { DERIV_SYMBOLS, DerivAccount, LiveTick, PurchaseDirection } from '../types/deriv';

type TickListener = (tick: LiveTick) => void;
type StatusListener = (status: 'connecting' | 'deriv-ws' | 'local-feed' | 'error') => void;

export function getDerivAppId(): string {
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem('deriv_app_id') : null;
  const envId = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DERIV_APP_ID;
  return (stored && stored.trim()) || (envId && envId.trim()) || '1089';
}

export function extractLastDigit(quote: number, pipSize: number): number {
  const formatted = quote.toFixed(pipSize);
  const lastChar = formatted[formatted.length - 1];
  return Number.parseInt(lastChar, 10) || 0;
}

class DerivMarketService {
  private ws: WebSocket | null = null;
  private activeSymbol = '1HZ100V';
  private tickListeners = new Set<TickListener>();
  private statusListeners = new Set<StatusListener>();
  private fallbackTimer: number | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private lastSpots: Record<string, number> = {};
  private currentStatus: 'connecting' | 'deriv-ws' | 'local-feed' | 'error' = 'connecting';
  private reqId = 1;
  private pendingRpc = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private historyResolve: ((ticks: LiveTick[]) => void) | null = null;

  constructor() {
    Object.values(DERIV_SYMBOLS).forEach((s) => {
      this.lastSpots[s.symbol] = s.baseSpot;
    });
  }

  public getStatus() {
    return this.currentStatus;
  }

  public onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  public onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    fn(this.currentStatus);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(status: 'connecting' | 'deriv-ws' | 'local-feed' | 'error') {
    this.currentStatus = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  public subscribeSymbol(symbol: string) {
    this.activeSymbol = symbol;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRaw({ forget_all: 'ticks' });
      this.sendRaw({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 60,
        end: 'latest',
        style: 'ticks',
        subscribe: 1,
      });
    } else {
      this.connect();
    }
  }

  public connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.stopFallback();
    this.setStatus('connecting');

    const appId = getDerivAppId();
    try {
      const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
      this.ws = ws;

      const connectTimeout = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          this.startFallbackFeed();
        }
      }, 4500);

      ws.onopen = () => {
        window.clearTimeout(connectTimeout);
        this.setStatus('deriv-ws');
        this.stopFallback();

        this.sendRaw({
          ticks_history: this.activeSymbol,
          adjust_start_time: 1,
          count: 60,
          end: 'latest',
          style: 'ticks',
          subscribe: 1,
        });

        this.pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            this.sendRaw({ ping: 1 });
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.req_id && this.pendingRpc.has(data.req_id)) {
            const pending = this.pendingRpc.get(data.req_id)!;
            this.pendingRpc.delete(data.req_id);
            if (data.error) {
              pending.reject(new Error(data.error.message || 'Deriv API Error'));
            } else {
              pending.resolve(data);
            }
          }

          if (data.msg_type === 'history' && data.history) {
            const sym = data.echo_req?.ticks_history || this.activeSymbol;
            const info = DERIV_SYMBOLS[sym] || DERIV_SYMBOLS['1HZ100V'];
            const prices: number[] = data.history.prices || [];
            const times: number[] = data.history.times || [];
            const ticks: LiveTick[] = prices.map((p, idx) => ({
              epoch: times[idx] || Math.floor(Date.now() / 1000),
              quote: Number(p),
              symbol: sym,
              lastDigit: extractLastDigit(Number(p), info.pipSize),
              source: 'deriv-ws',
            }));
            if (ticks.length > 0) {
              this.lastSpots[sym] = ticks[ticks.length - 1].quote;
              if (this.historyResolve) {
                this.historyResolve(ticks);
                this.historyResolve = null;
              }
              ticks.forEach((t) => this.emitTick(t));
            }
          }

          if (data.msg_type === 'tick' && data.tick) {
            const sym = data.tick.symbol;
            if (sym !== this.activeSymbol) return;
            const info = DERIV_SYMBOLS[sym] || DERIV_SYMBOLS['1HZ100V'];
            const quote = Number(data.tick.quote);
            this.lastSpots[sym] = quote;
            this.emitTick({
              epoch: Number(data.tick.epoch),
              quote,
              symbol: sym,
              lastDigit: extractLastDigit(quote, info.pipSize),
              source: 'deriv-ws',
            });
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        window.clearTimeout(connectTimeout);
        this.startFallbackFeed();
      };

      ws.onclose = () => {
        window.clearTimeout(connectTimeout);
        if (this.pingTimer) {
          window.clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.ws = null;
        this.startFallbackFeed();
      };
    } catch {
      this.startFallbackFeed();
    }
  }

  private emitTick(tick: LiveTick) {
    this.tickListeners.forEach((fn) => fn(tick));
  }

  private sendRaw(payload: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  public rpc<T = any>(payload: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Deriv WebSocket is not connected.'));
        return;
      }
      const req_id = ++this.reqId;
      this.pendingRpc.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
      window.setTimeout(() => {
        if (this.pendingRpc.has(req_id)) {
          this.pendingRpc.delete(req_id);
          reject(new Error('Deriv API request timed out'));
        }
      }, 10000);
    });
  }

  public async authorizeAccount(token: string): Promise<DerivAccount> {
    const res = await this.rpc<{ authorize: any }>({ authorize: token });
    const auth = res.authorize;
    return {
      loginid: auth.loginid,
      token,
      currency: auth.currency || 'USD',
      balance: Number(auth.balance || 0),
      isVirtual: Boolean(auth.is_virtual),
      email: auth.email,
      fullname: auth.fullname,
    };
  }

  public async buyRealContract(params: {
    symbol: string;
    contractType: PurchaseDirection;
    amount: number;
    duration: number;
    durationUnit: 't' | 's' | 'm';
    prediction?: number;
    growthRate?: number;
    takeProfit?: number;
    takeProfitEnabled?: boolean;
  }): Promise<{ contractId: string; buyPrice: number; longcode: string }> {
    const parameters: Record<string, unknown> = {
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contractType,
      currency: 'USD',
      symbol: params.symbol,
    };

    if (params.contractType === 'ACCU') {
      parameters.growth_rate = params.growthRate ?? 0.02;
      if (params.takeProfitEnabled && params.takeProfit && params.takeProfit > 0) {
        parameters.limit_order = { take_profit: params.takeProfit };
      }
    } else {
      parameters.duration = params.duration;
      parameters.duration_unit = params.durationUnit;
      if (params.contractType === 'DIGITMATCH' || params.contractType === 'DIGITDIFF') {
        parameters.barrier = String(params.prediction ?? 1);
      }
    }

    const res = await this.rpc<{ buy: { contract_id: number; buy_price: number; longcode: string } }>({
      buy: 1,
      price: params.amount,
      parameters,
    });

    return {
      contractId: String(res.buy.contract_id),
      buyPrice: Number(res.buy.buy_price),
      longcode: res.buy.longcode,
    };
  }

  public async getContractStatus(contractId: string) {
    const res = await this.rpc<{ proposal_open_contract: any }>({
      proposal_open_contract: 1,
      contract_id: Number(contractId),
    });
    return res.proposal_open_contract;
  }

  public async sellContract(contractId: string) {
    const res = await this.rpc<{ sell: { sold_for: number; transaction_id: number } }>({
      sell: Number(contractId),
      price: 0,
    });
    return res.sell;
  }

  private startFallbackFeed() {
    if (this.fallbackTimer !== null) return;
    this.setStatus('local-feed');

    // Emit initial 40 historical ticks for immediate chart clarity
    const info = DERIV_SYMBOLS[this.activeSymbol] || DERIV_SYMBOLS['1HZ100V'];
    let spot = this.lastSpots[this.activeSymbol] || info.baseSpot;
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 40; i >= 1; i--) {
      spot = Number((spot + (Math.random() - 0.5) * info.volatilityFactor * 2).toFixed(info.pipSize));
      this.emitTick({
        epoch: nowSec - i,
        quote: spot,
        symbol: this.activeSymbol,
        lastDigit: extractLastDigit(spot, info.pipSize),
        source: 'local-feed',
      });
    }
    this.lastSpots[this.activeSymbol] = spot;

    this.fallbackTimer = window.setInterval(() => {
      const activeInfo = DERIV_SYMBOLS[this.activeSymbol] || DERIV_SYMBOLS['1HZ100V'];
      const current = this.lastSpots[this.activeSymbol] || activeInfo.baseSpot;
      const delta = (Math.random() - 0.498) * activeInfo.volatilityFactor * 2;
      const nextSpot = Number((current + delta).toFixed(activeInfo.pipSize));
      this.lastSpots[this.activeSymbol] = nextSpot;
      this.emitTick({
        epoch: Math.floor(Date.now() / 1000),
        quote: nextSpot,
        symbol: this.activeSymbol,
        lastDigit: extractLastDigit(nextSpot, activeInfo.pipSize),
        source: 'local-feed',
      });
    }, 1000);

    // Retry real Deriv WS silently every 30s
    if (this.reconnectTimer === null) {
      this.reconnectTimer = window.setInterval(() => {
        if (!this.ws) {
          this.connect();
        }
      }, 30000);
    }
  }

  private stopFallback() {
    if (this.fallbackTimer !== null) {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const derivService = new DerivMarketService();

export function parseDerivOAuthFromUrl(): { loginid: string; token: string; currency: string }[] {
  if (typeof window === 'undefined') return [];
  const params = new URLSearchParams(window.location.search);
  const accounts: { loginid: string; token: string; currency: string }[] = [];
  for (let i = 1; i <= 10; i++) {
    const acct = params.get(`acct${i}`);
    const token = params.get(`token${i}`);
    const cur = params.get(`cur${i}`) || 'USD';
    if (acct && token) {
      accounts.push({ loginid: acct, token, currency: cur });
    }
  }
  return accounts;
}

export function buildDerivOAuthUrl(appId: string): string {
  const redirectUri = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
  return `https://oauth.deriv.com/oauth2/authorize?app_id=${encodeURIComponent(appId)}&l=EN&brand=deriv&redirect_uri=${encodeURIComponent(redirectUri)}`;
}
