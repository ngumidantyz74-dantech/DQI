import type { ActiveSymbol, CandleBar, ContractSupport, LiveTickEvent } from '../types/dqi';

const APP_ID =
  (typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DERIV_APP_ID) ||
  '1089';

const WS_HOSTS = [
  `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`,
  `wss://green.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`,
  `wss://blue.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`,
];

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

class BrowserDerivPublicClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private hostIdx = 0;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (data: Record<string, unknown>) => void; reject: (err: Error) => void; timer: number }
  >();
  private listeners = new Map<string, Set<(tick: LiveTickEvent) => void>>();
  private pipSizeBySymbol = new Map<string, number>();
  private tickBuffers = new Map<string, LiveTickEvent[]>();

  private async ensureWs(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let lastErr: Error | null = null;
      for (let i = 0; i < WS_HOSTS.length; i += 1) {
        const idx = (this.hostIdx + i) % WS_HOSTS.length;
        const url = WS_HOSTS[idx];
        try {
          const ws = await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url);
            const t = window.setTimeout(() => {
              try {
                socket.close();
              } catch {
                // ignore
              }
              reject(new Error('Browser Deriv WebSocket connection timed out'));
            }, 6500);

            socket.onopen = () => {
              window.clearTimeout(t);
              resolve(socket);
            };
            socket.onerror = () => {
              window.clearTimeout(t);
              reject(new Error('Browser Deriv WebSocket connection failed'));
            };
          });

          this.hostIdx = idx;
          this.ws = ws;
          ws.onmessage = (ev) => this.handleMessage(String(ev.data));
          ws.onclose = () => {
            this.ws = null;
            for (const [id, entry] of this.pending.entries()) {
              window.clearTimeout(entry.timer);
              entry.reject(new Error('Deriv WebSocket closed'));
              this.pending.delete(id);
            }
          };

          // Re-subscribe active listeners
          for (const sym of this.listeners.keys()) {
            ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
          }

          return ws;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      throw lastErr || new Error('Unable to connect to Deriv public WebSocket');
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

      const subs = this.listeners.get(tick.symbol);
      if (subs) {
        for (const cb of subs) cb(evt);
      }
    }
  }

  private async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = await this.ensureWs();
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Deriv request timed out'));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

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
      ((res.contracts_for as { available?: Array<{ contract_type?: string; min_contract_duration?: string; max_contract_duration?: string }> })?.available) ??
      [];
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
    const raw = (res.candles as Array<{ epoch: number; open: string | number; high: string | number; low: string | number; close: string | number }> | undefined) ?? [];
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
      currency: 'USD',
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
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
    }
    const cb = (t: LiveTickEvent) => {
      if (!closed) handlers.onTick?.(t);
    };
    set.add(cb);

    void (async () => {
      try {
        const ws = await this.ensureWs();
        if (closed) return;
        const history = await this.fetchTickHistory(symbol, 120);
        if (closed) return;
        handlers.onReady?.({
          symbol,
          bufferedCount: history.length,
          pipSize: this.pipSizeBySymbol.get(symbol) ?? 2,
        });
        handlers.onHistory?.(history);
        handlers.onHealth?.({ connectionState: 'LIVE', isStale: false, ageSeconds: 0 });
        ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
      } catch (err) {
        if (!closed) {
          handlers.onError?.(err instanceof Error ? err.message : 'Browser Deriv WebSocket failed');
        }
      }
    })();

    return () => {
      closed = true;
      const cur = this.listeners.get(symbol);
      if (cur) {
        cur.delete(cb);
        if (cur.size === 0) {
          this.listeners.delete(symbol);
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

export const browserDerivPublic = new BrowserDerivPublicClient();
