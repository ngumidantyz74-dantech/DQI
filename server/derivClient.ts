import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { serverConfig } from './config.ts';
import { extractExactLastDigit, type Candle, type RawTick } from './quantEngine.ts';

export interface ActiveSymbolItem {
  symbol: string;
  display_name: string;
  market: string;
  market_display_name: string;
  submarket: string;
  submarket_display_name: string;
  pip: number;
  pip_size: number;
  exchange_is_open: number;
  is_trading_suspended: number;
}

export interface ContractSupportSummary {
  symbol: string;
  supportedTypes: string[];
  supportsDigits: boolean;
  supportsMatch: boolean;
  supportsDiffer: boolean;
  supportsOverUnder: boolean;
  supportsEvenOdd: boolean;
  supportsRiseFall: boolean;
  minDurationTicks: number | null;
  maxDurationTicks: number | null;
  checkedAt: string;
}

function pipDecimalPlaces(pip: unknown): number | undefined {
  if (typeof pip === 'number' && Number.isFinite(pip) && pip > 0) {
    if (Number.isInteger(pip) && pip >= 0 && pip <= 12) return pip;
    const str = pip.toString();
    if (str.includes('e-')) {
      const exp = Number.parseInt(str.split('e-')[1], 10);
      return Number.isFinite(exp) ? exp : undefined;
    }
    const dot = str.indexOf('.');
    return dot >= 0 ? str.length - dot - 1 : 0;
  }
  return undefined;
}

class DerivPublicService extends EventEmitter {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  private pending = new Map<
    number,
    {
      resolve: (value: Record<string, any>) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private activeSubscriptions = new Set<string>();
  private symbolCache: { items: ActiveSymbolItem[]; fetchedAt: number } = { items: [], fetchedAt: 0 };
  private contractsCache = new Map<string, { summary: ContractSupportSummary; fetchedAt: number }>();
  private tickBuffers = new Map<string, RawTick[]>();
  private pipSizeBySymbol = new Map<string, number>();

  private connectionState: 'CONNECTING' | 'LIVE' | 'DISCONNECTED' | 'ERROR' = 'DISCONNECTED';
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;

  public getHealthState() {
    const now = Date.now();
    const ageSeconds = this.lastMessageAt ? Math.floor((now - this.lastMessageAt) / 1000) : null;
    const isStale = ageSeconds === null || ageSeconds > 15;
    return {
      connectionState: this.connectionState,
      isConnected: this.ws?.readyState === WebSocket.OPEN,
      isStale,
      ageSeconds,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastError: this.lastError,
      subscribedSymbols: Array.from(this.activeSubscriptions),
    };
  }

  public getPipSize(symbol: string): number {
    return this.pipSizeBySymbol.get(symbol) ?? 2;
  }

  public getBufferedTicks(symbol: string): RawTick[] {
    return this.tickBuffers.get(symbol) ?? [];
  }

  private pushTickToBuffer(tick: RawTick): void {
    let list = this.tickBuffers.get(tick.symbol);
    if (!list) {
      list = [];
      this.tickBuffers.set(tick.symbol, list);
    }
    const last = list[list.length - 1];
    if (last && last.epoch === tick.epoch && last.rawQuote === tick.rawQuote) {
      return;
    }
    list.push(tick);
    if (list.length > 5000) {
      list.splice(0, list.length - 5000);
    }
  }

  private hostIndex = 0;

  private candidateWsHosts(): string[] {
    const configured = serverConfig.derivPublicWsUrl || 'wss://ws.derivws.com/websockets/v3';
    const defaults = [
      configured,
      'wss://green.derivws.com/websockets/v3',
      'wss://blue.derivws.com/websockets/v3',
    ];
    return Array.from(new Set(defaults));
  }

  private wsEndpointUrl(baseOverride?: string): string {
    const base = baseOverride || this.candidateWsHosts()[this.hostIndex % this.candidateWsHosts().length];
    if (base.includes('app_id=')) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}app_id=${encodeURIComponent(serverConfig.derivAppId || '1089')}`;
  }

  public async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      this.connectionState = 'CONNECTING';
      const hosts = this.candidateWsHosts();
      let lastErr: Error | null = null;

      for (let i = 0; i < hosts.length; i += 1) {
        const idx = (this.hostIndex + i) % hosts.length;
        const url = this.wsEndpointUrl(hosts[idx]);
        try {
          await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(url, { handshakeTimeout: 4_500, perMessageDeflate: false });
            const timeout = setTimeout(() => {
              try {
                ws.terminate();
              } catch {
                // ignore
              }
              reject(new Error('Deriv public WebSocket connection timed out'));
            }, 5_000);

            ws.once('open', () => {
              clearTimeout(timeout);
              this.hostIndex = idx;
              this.ws = ws;
              this.reconnectAttempt = 0;
              this.connectionState = 'LIVE';
              this.lastError = null;
              this.lastMessageAt = Date.now();
              this.attachHandlers(ws);
              for (const sym of this.activeSubscriptions) {
                try {
                  ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
                } catch {
                  // ignore
                }
              }
              resolve();
            });

            ws.once('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });
          return;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          this.lastError = lastErr.message;
        }
      }

      this.connectionState = 'ERROR';
      throw lastErr || new Error('Unable to connect to Deriv public WebSocket');
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private attachHandlers(ws: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ ping: 1 }));
        } catch {
          // ignore
        }
      }
    }, 25_000);
    this.pingTimer.unref();

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (typeof msg.req_id === 'number' && this.pending.has(msg.req_id)) {
        const entry = this.pending.get(msg.req_id)!;
        clearTimeout(entry.timer);
        this.pending.delete(msg.req_id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'Deriv API error'));
        } else {
          entry.resolve(msg);
        }
      }

      if (msg.msg_type === 'tick' && msg.tick) {
        const t = msg.tick;
        const symbol = String(t.symbol || '');
        if (!symbol || t.quote === undefined || t.epoch === undefined) return;
        const pipSize =
          typeof t.pip_size === 'number' && Number.isInteger(t.pip_size)
            ? t.pip_size
            : this.getPipSize(symbol);
        if (typeof t.pip_size === 'number') this.pipSizeBySymbol.set(symbol, t.pip_size);
        try {
          const extracted = extractExactLastDigit(String(t.quote), pipSize);
          const parsedTick: RawTick = {
            symbol,
            epoch: Number(t.epoch),
            rawQuote: extracted.formattedQuote,
            quote: Number(t.quote),
            pipSize: extracted.pipSize,
            lastDigit: extracted.lastDigit,
            receivedAt: new Date().toISOString(),
            source: 'DERIV_PUBLIC_WS',
          };
          this.pushTickToBuffer(parsedTick);
          this.emit('tick', parsedTick);
        } catch {
          // ignore invalid tick
        }
      }
    });

    ws.on('close', () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.ws === ws) {
        this.ws = null;
        this.connectionState = 'DISCONNECTED';
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Deriv WebSocket closed'));
        }
        this.pending.clear();
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.lastError = err.message;
      this.connectionState = 'ERROR';
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.activeSubscriptions.size === 0) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5)) + Math.floor(Math.random() * 500);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  public async request<T = Record<string, any>>(payload: Record<string, unknown>, timeoutMs = 12_000): Promise<T> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Deriv public WebSocket is disconnected');
    }
    const reqId = this.reqId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Deriv API request timed out'));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: resolve as (v: Record<string, any>) => void,
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  public async getActiveSymbols(forceRefresh = false): Promise<ActiveSymbolItem[]> {
    const now = Date.now();
    if (!forceRefresh && this.symbolCache.items.length > 0 && now - this.symbolCache.fetchedAt < 300_000) {
      return this.symbolCache.items;
    }
    const response = await this.request<{ active_symbols?: Array<Record<string, any>> }>({
      active_symbols: 'brief',
      product_type: 'basic',
    });
    const rawList = Array.isArray(response.active_symbols) ? response.active_symbols : [];
    const mapped: ActiveSymbolItem[] = rawList
      .filter((item) => item && item.symbol)
      .map((item) => {
        const symbol = String(item.symbol);
        const pipSize = pipDecimalPlaces(item.pip) ?? 2;
        this.pipSizeBySymbol.set(symbol, pipSize);
        return {
          symbol,
          display_name: String(item.display_name || symbol),
          market: String(item.market || 'unknown'),
          market_display_name: String(item.market_display_name || item.market || 'Deriv'),
          submarket: String(item.submarket || ''),
          submarket_display_name: String(item.submarket_display_name || ''),
          pip: Number(item.pip || 0.01),
          pip_size: pipSize,
          exchange_is_open: Number(item.exchange_is_open ?? 1),
          is_trading_suspended: Number(item.is_trading_suspended ?? 0),
        };
      });
    this.symbolCache = { items: mapped, fetchedAt: now };
    return mapped;
  }

  public async getContractsFor(symbol: string): Promise<ContractSupportSummary> {
    const cached = this.contractsCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 300_000) {
      return cached.summary;
    }
    const res = await this.request<{ contracts_for?: { available?: Array<Record<string, any>> } }>({
      contracts_for: symbol,
      currency: 'USD',
      product_type: 'basic',
    });
    const available = Array.isArray(res.contracts_for?.available) ? res.contracts_for!.available : [];
    const types = new Set<string>();
    let minTicks: number | null = null;
    let maxTicks: number | null = null;

    for (const c of available) {
      const ct = String(c.contract_type || '').toUpperCase();
      if (ct) types.add(ct);
      if (ct.startsWith('DIGIT')) {
        const minStr = String(c.min_contract_duration || '');
        const maxStr = String(c.max_contract_duration || '');
        const minMatch = minStr.match(/^(\d+)t$/);
        const maxMatch = maxStr.match(/^(\d+)t$/);
        if (minMatch) {
          const val = Number.parseInt(minMatch[1], 10);
          minTicks = minTicks === null ? val : Math.min(minTicks, val);
        }
        if (maxMatch) {
          const val = Number.parseInt(maxMatch[1], 10);
          maxTicks = maxTicks === null ? val : Math.max(maxTicks, val);
        }
      }
    }

    const supportedTypes = Array.from(types).sort();
    const summary: ContractSupportSummary = {
      symbol,
      supportedTypes,
      supportsMatch: types.has('DIGITMATCH'),
      supportsDiffer: types.has('DIGITDIFF'),
      supportsOverUnder: types.has('DIGITOVER') && types.has('DIGITUNDER'),
      supportsEvenOdd: types.has('DIGITEVEN') && types.has('DIGITODD'),
      supportsDigits:
        types.has('DIGITMATCH') ||
        types.has('DIGITDIFF') ||
        types.has('DIGITOVER') ||
        types.has('DIGITEVEN'),
      supportsRiseFall: types.has('CALL') || types.has('PUT'),
      minDurationTicks: minTicks,
      maxDurationTicks: maxTicks,
      checkedAt: new Date().toISOString(),
    };
    this.contractsCache.set(symbol, { summary, fetchedAt: Date.now() });
    return summary;
  }

  public async fetchCandles(symbol: string, granularity: number, count = 250): Promise<Candle[]> {
    const res = await this.request<{ candles?: Array<Record<string, any>> }>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: Math.min(Math.max(count, 35), 2000),
      end: 'latest',
      style: 'candles',
      granularity,
    });
    const rawCandles = Array.isArray(res.candles) ? res.candles : [];
    return rawCandles
      .map((c) => ({
        epoch: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }))
      .filter((c) => Number.isFinite(c.epoch) && Number.isFinite(c.close));
  }

  public async fetchTickHistory(symbol: string, count = 500): Promise<RawTick[]> {
    const res = await this.request<{
      pip_size?: number;
      history?: { prices?: Array<string | number>; times?: number[] };
    }>({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: Math.min(Math.max(count, 20), 5000),
      end: 'latest',
      style: 'ticks',
    });
    const pipSize =
      typeof res.pip_size === 'number' && Number.isInteger(res.pip_size)
        ? res.pip_size
        : this.getPipSize(symbol);
    if (typeof res.pip_size === 'number') this.pipSizeBySymbol.set(symbol, res.pip_size);

    const prices = res.history?.prices ?? [];
    const times = res.history?.times ?? [];
    const out: RawTick[] = [];
    for (let i = 0; i < prices.length; i += 1) {
      const p = prices[i];
      const ep = Number(times[i]);
      if (p === undefined || !Number.isFinite(ep)) continue;
      try {
        const extracted = extractExactLastDigit(String(p), pipSize);
        const tick: RawTick = {
          symbol,
          epoch: ep,
          rawQuote: extracted.formattedQuote,
          quote: Number(p),
          pipSize: extracted.pipSize,
          lastDigit: extracted.lastDigit,
          receivedAt: new Date(ep * 1000).toISOString(),
          source: 'DERIV_PUBLIC_HISTORY',
        };
        this.pushTickToBuffer(tick);
        out.push(tick);
      } catch {
        // skip malformed point
      }
    }
    return out;
  }

  public async subscribeSymbol(symbol: string): Promise<void> {
    if (!/^[A-Za-z0-9_]{2,30}$/.test(symbol)) throw new Error('Invalid symbol code');
    // Keep subscription count bounded
    if (!this.activeSubscriptions.has(symbol) && this.activeSubscriptions.size >= 25) {
      const oldest = this.activeSubscriptions.values().next().value;
      if (oldest) this.activeSubscriptions.delete(oldest);
    }
    this.activeSubscriptions.add(symbol);
    await this.ensureConnected();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    }
  }

  public async fetchProposal(params: {
    symbol: string;
    contractType: string;
    amount: number;
    currency?: string;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    barrier?: string;
  }) {
    const req: Record<string, unknown> = {
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contractType,
      currency: params.currency || 'USD',
      duration: params.duration,
      duration_unit: params.durationUnit,
      symbol: params.symbol,
    };
    if (params.barrier !== undefined && params.barrier !== '') {
      req.barrier = String(params.barrier);
    }
    const res = await this.request<{ proposal?: Record<string, any> }>(req);
    const p = res.proposal;
    if (!p || !p.id) throw new Error('Deriv did not return a valid proposal');
    return {
      proposalId: String(p.id),
      askPrice: Number(p.ask_price),
      payout: Number(p.payout),
      spot: Number(p.spot),
      longcode: String(p.longcode || ''),
      dateExpiry: p.date_expiry ? Number(p.date_expiry) : null,
      fetchedAt: new Date().toISOString(),
    };
  }

  public async getLatestTick(symbol: string): Promise<RawTick> {
    const res = await this.request<{ tick?: Record<string, any> }>({ ticks: symbol });
    const t = res.tick;
    if (!t || t.quote === undefined || t.epoch === undefined) {
      throw new Error(`No live tick returned for ${symbol}`);
    }
    const pipSize = typeof t.pip_size === 'number' ? t.pip_size : this.getPipSize(symbol);
    const extracted = extractExactLastDigit(String(t.quote), pipSize);
    const tick: RawTick = {
      symbol,
      epoch: Number(t.epoch),
      rawQuote: extracted.formattedQuote,
      quote: Number(t.quote),
      pipSize: extracted.pipSize,
      lastDigit: extracted.lastDigit,
      receivedAt: new Date().toISOString(),
      source: 'DERIV_PUBLIC_WS',
    };
    this.pushTickToBuffer(tick);
    return tick;
  }

  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const derivPublic = new DerivPublicService();
