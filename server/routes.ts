import type { Express, Request, Response } from 'express';
import WebSocket from 'ws';
import { z } from 'zod';
import { serverConfig, isDerivOAuthConfigured } from './config.ts';
import {
  checkDatabaseHealth,
  getPool,
  previewStore,
  runPendingMigrations,
} from './db.ts';
import { derivPublic } from './derivClient.ts';
import {
  TIMEFRAMES,
  type QuantAnalysisResult,
  analyzeCandles,
  analyzeDigitStream,
  analyzeTickVolatility,
  calibrateConfidence,
  evaluateMatchDifferCandidates,
  fitPlattCalibration,
  fromCents,
  multiTimeframeAnalysis,
  runBacktest,
  toCents,
  validatePaperOrder,
  walkForwardValidation,
} from './quantEngine.ts';
import {
  QUANT_ADMIN_COOKIE,
  checkLoginRateLimit,
  clearAuthCookie,
  clearFailedLoginAttempts,
  decryptSecret,
  encryptSecret,
  hashPasswordScrypt,
  pkceChallenge,
  randomToken,
  recordFailedLoginAttempt,
  setAuthCookie,
  sha256,
  signAdminSessionToken,
  verifyAdminSessionToken,
  verifyMutationOrigin,
  verifyPassword,
} from './security.ts';
import { generateAiMarketBrief } from './aiAnalyzer.ts';

const SYMBOL_REGEX = /^[A-Za-z0-9_]{2,30}$/;

function isQuantAdminConfigured(): boolean {
  return Boolean(serverConfig.quantAdminPasswordHash || previewStore.claimedAdminHash);
}

function activeAdminHash(): string {
  // Configured process.env hash always overrides any claimed preview hash
  return serverConfig.quantAdminPasswordHash || previewStore.claimedAdminHash || '';
}

function isRequestAdminAuthenticated(req: Request): boolean {
  if (!isQuantAdminConfigured()) return false;
  const cookieToken = req.cookies?.[QUANT_ADMIN_COOKIE];
  return verifyAdminSessionToken(cookieToken);
}

export function registerApiRoutes(app: Express): void {
  app.use('/api', verifyMutationOrigin);

  // ---------------- HEALTH & SYSTEM ----------------

  app.get('/api/health', async (_req: Request, res: Response) => {
    const db = await checkDatabaseHealth();
    const feed = derivPublic.getHealthState();
    res.json({
      status: 'ok',
      service: 'dqi-unified-terminal',
      version: '7.0.0',
      liveTradingEnabled: serverConfig.liveTradingEnabled && !previewStore.liveGate.kill_switch,
      recoveryEnabled: serverConfig.recoveryEnabled,
      derivOAuthConfigured: isDerivOAuthConfigured(),
      database: db,
      marketFeed: feed,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/v1/system/status', async (_req: Request, res: Response) => {
    const db = await checkDatabaseHealth();
    res.json({
      database: db,
      oauthConfigured: isDerivOAuthConfigured(),
      liveDeploymentGate: serverConfig.liveTradingEnabled,
      recoveryDeploymentGate: serverConfig.recoveryEnabled,
      quantAdminConfigured: isQuantAdminConfigured(),
      quantAdminFromEnv: Boolean(serverConfig.quantAdminPasswordHash),
      derivAppId: serverConfig.derivAppId,
      derivWsUrl: serverConfig.derivPublicWsUrl,
    });
  });

  app.post('/api/v1/system/migrate', async (req: Request, res: Response) => {
    if (isQuantAdminConfigured() && !isRequestAdminAuthenticated(req)) {
      res.status(401).json({ error: 'ADMIN_AUTHENTICATION_REQUIRED' });
      return;
    }
    try {
      const result = await runPendingMigrations();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  // ---------------- QUANT ADMIN SESSION ----------------

  app.get('/api/v1/quant/session', (req: Request, res: Response) => {
    res.json({
      configured: isQuantAdminConfigured(),
      fromEnv: Boolean(serverConfig.quantAdminPasswordHash),
      authenticated: isRequestAdminAuthenticated(req),
    });
  });

  app.post('/api/v1/quant/auth/claim', (req: Request, res: Response) => {
    if (isQuantAdminConfigured()) {
      res.status(409).json({ error: 'ADMIN_PASSWORD_ALREADY_CONFIGURED' });
      return;
    }
    const parsed = z.object({ password: z.string().min(8).max(128) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
      return;
    }
    previewStore.claimedAdminHash = hashPasswordScrypt(parsed.data.password);
    const token = signAdminSessionToken();
    setAuthCookie(res, QUANT_ADMIN_COOKIE, token, serverConfig.sessionTtlSeconds, req);
    res.json({ authenticated: true, configured: true });
  });

  app.post('/api/v1/quant/auth/login', (req: Request, res: Response) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'local');
    const rate = checkLoginRateLimit(ip);
    if (!rate.allowed) {
      res.status(429).json({ error: `Too many attempts. Retry in ${rate.retryAfterSec}s.` });
      return;
    }
    const parsed = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    const hash = activeAdminHash();
    if (!hash) {
      res.status(503).json({ error: 'Quant admin password has not been configured yet' });
      return;
    }
    if (!verifyPassword(parsed.data.password, hash)) {
      recordFailedLoginAttempt(ip);
      res.status(401).json({ error: 'Invalid administrator password' });
      return;
    }
    clearFailedLoginAttempts(ip);
    const token = signAdminSessionToken();
    setAuthCookie(res, QUANT_ADMIN_COOKIE, token, serverConfig.sessionTtlSeconds, req);
    res.json({ authenticated: true, expiresIn: serverConfig.sessionTtlSeconds });
  });

  app.post('/api/v1/quant/auth/logout', (req: Request, res: Response) => {
    clearAuthCookie(res, QUANT_ADMIN_COOKIE, req);
    res.json({ authenticated: false });
  });

  // ---------------- DERIV MARKET DATA & STREAM ----------------

  app.get('/api/v1/markets/symbols', async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === 'true';
      const symbols = await derivPublic.getActiveSymbols(refresh);
      res.json({
        symbols,
        count: symbols.length,
        source: 'DERIV_PUBLIC_WS',
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to discover Deriv symbols',
        source: 'DERIV_PUBLIC_WS',
      });
    }
  });

  app.get('/api/v1/markets/contracts/:symbol', async (req: Request, res: Response) => {
    const symbol = String(req.params.symbol || '');
    if (!SYMBOL_REGEX.test(symbol)) {
      res.status(400).json({ error: 'INVALID_SYMBOL' });
      return;
    }
    try {
      const support = await derivPublic.getContractsFor(symbol);
      res.json(support);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to query Deriv contracts_for' });
    }
  });

  app.get('/api/v1/markets/history/:symbol', async (req: Request, res: Response) => {
    const symbol = String(req.params.symbol || '');
    if (!SYMBOL_REGEX.test(symbol)) {
      res.status(400).json({ error: 'INVALID_SYMBOL' });
      return;
    }
    const style = req.query.style === 'ticks' ? 'ticks' : 'candles';
    const count = Math.min(Math.max(Number(req.query.count) || 250, 20), 2000);
    const granularity = Number(req.query.granularity) || 60;
    try {
      if (style === 'ticks') {
        const ticks = await derivPublic.fetchTickHistory(symbol, count);
        res.json({ symbol, style: 'ticks', ticks, pipSize: derivPublic.getPipSize(symbol) });
      } else {
        const candles = await derivPublic.fetchCandles(symbol, granularity, count);
        res.json({ symbol, style: 'candles', granularity, candles });
      }
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to fetch Deriv history' });
    }
  });

  app.post('/api/v1/markets/proposal', async (req: Request, res: Response) => {
    const schema = z.object({
      symbol: z.string().regex(SYMBOL_REGEX),
      contractType: z.enum(['CALL', 'PUT', 'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD']),
      amount: z.number().positive().max(10000),
      duration: z.number().int().min(1).max(86400),
      durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).default('t'),
      barrier: z.string().optional(),
      currency: z.string().min(3).max(8).default('USD'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PROPOSAL_REQUEST', details: parsed.error.flatten() });
      return;
    }
    try {
      const proposal = await derivPublic.fetchProposal(parsed.data);
      const breakEvenProb = proposal.payout > 0 ? Number(((proposal.askPrice / proposal.payout) * 100).toFixed(2)) : null;
      res.json({ ...proposal, breakEvenProbPct: breakEvenProb, source: 'DERIV_LIVE_PROPOSAL' });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Deriv proposal unavailable' });
    }
  });

  app.get('/api/v1/markets/stream', async (req: Request, res: Response) => {
    const symbol = String(req.query.symbol || '');
    if (!SYMBOL_REGEX.test(symbol)) {
      res.status(400).json({ error: 'VALID_SYMBOL_REQUIRED' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      await derivPublic.subscribeSymbol(symbol);
      const recent = derivPublic.getBufferedTicks(symbol).slice(-60);
      sendEvent('ready', { symbol, bufferedCount: recent.length, pipSize: derivPublic.getPipSize(symbol) });
      if (recent.length > 0) {
        sendEvent('history', { symbol, ticks: recent });
      }
    } catch (err) {
      sendEvent('feed_error', { message: err instanceof Error ? err.message : 'Feed unavailable' });
    }

    const onTick = (tick: { symbol: string }) => {
      if (tick.symbol === symbol) {
        sendEvent('tick', tick);
      }
    };

    derivPublic.on('tick', onTick);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        sendEvent('health', derivPublic.getHealthState());
      }
    }, 10_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      derivPublic.off('tick', onTick);
    });
  });

  // ---------------- DIGITS INTELLIGENCE & MATCH/DIFFER SPECIALIST ----------------

  app.get('/api/v1/digits/analyze/:symbol', async (req: Request, res: Response) => {
    const symbol = String(req.params.symbol || '');
    if (!SYMBOL_REGEX.test(symbol)) {
      res.status(400).json({ error: 'INVALID_SYMBOL' });
      return;
    }
    const windowSize = Math.min(Math.max(Number(req.query.window) || 100, 10), 5000);
    const stake = Math.min(Math.max(Number(req.query.stake) || 1, 0.35), 1000);
    const durationTicks = Math.min(Math.max(Number(req.query.duration) || 1, 1), 10);

    try {
      let ticks = derivPublic.getBufferedTicks(symbol);
      if (ticks.length < Math.min(windowSize, 250)) {
        ticks = await derivPublic.fetchTickHistory(symbol, Math.max(windowSize, 250));
      }
      await derivPublic.subscribeSymbol(symbol);

      const support = await derivPublic.getContractsFor(symbol);
      const analytics = analyzeDigitStream(symbol, ticks, windowSize);
      const volatility = analyzeTickVolatility(symbol, ticks, Math.min(windowSize, 100));

      // Fetch real live Deriv proposal quotes for Match & Differ when supported
      let matchProposal: { askPrice: number; payout: number } | null = null;
      let differProposal: { askPrice: number; payout: number } | null = null;
      const tasks: Array<Promise<void>> = [];

      if (support.supportsMatch) {
        tasks.push(
          derivPublic
            .fetchProposal({
              symbol,
              contractType: 'DIGITMATCH',
              amount: stake,
              duration: durationTicks,
              durationUnit: 't',
              barrier: '0',
            })
            .then((p) => {
              matchProposal = { askPrice: p.askPrice, payout: p.payout };
            })
            .catch(() => {
              matchProposal = null;
            })
        );
      }
      if (support.supportsDiffer) {
        tasks.push(
          derivPublic
            .fetchProposal({
              symbol,
              contractType: 'DIGITDIFF',
              amount: stake,
              duration: durationTicks,
              durationUnit: 't',
              barrier: '0',
            })
            .then((p) => {
              differProposal = { askPrice: p.askPrice, payout: p.payout };
            })
            .catch(() => {
              differProposal = null;
            })
        );
      }
      await Promise.all(tasks);

      const candidates = evaluateMatchDifferCandidates(analytics, volatility.regime, {
        match: matchProposal,
        differ: differProposal,
      });

      res.json({
        analytics,
        volatility,
        contractSupport: support,
        proposals: {
          match: matchProposal,
          differ: differProposal,
          stake,
          durationTicks,
        },
        ...candidates,
        feedHealth: derivPublic.getHealthState(),
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Unable to analyze digits stream',
        feedHealth: derivPublic.getHealthState(),
      });
    }
  });

  app.post('/api/v1/digits/compute', (req: Request, res: Response) => {
    const tickSchema = z.object({
      symbol: z.string().regex(SYMBOL_REGEX),
      epoch: z.number(),
      rawQuote: z.string(),
      quote: z.number(),
      pipSize: z.number().int().min(0).max(12),
      lastDigit: z.number().int().min(0).max(9),
      receivedAt: z.string().default(() => new Date().toISOString()),
      source: z.string().default('DERIV_BROWSER_WS'),
    });
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        window: z.number().int().min(10).max(5000).default(100),
        stake: z.number().positive().max(1000).default(1),
        durationTicks: z.number().int().min(1).max(10).default(1),
        ticks: z.array(tickSchema).min(1).max(5000),
        contractSupport: z.any().optional(),
        proposals: z
          .object({
            match: z.object({ askPrice: z.number(), payout: z.number() }).nullable().optional(),
            differ: z.object({ askPrice: z.number(), payout: z.number() }).nullable().optional(),
          })
          .optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_DIGITS_COMPUTE_PAYLOAD' });
      return;
    }

    const { symbol, window, stake, durationTicks, ticks, contractSupport, proposals } = parsed.data;
    const analytics = analyzeDigitStream(symbol, ticks, window);
    const volatility = analyzeTickVolatility(symbol, ticks, Math.min(window, 100));
    const matchProposal = proposals?.match ?? null;
    const differProposal = proposals?.differ ?? null;
    const candidates = evaluateMatchDifferCandidates(analytics, volatility.regime, {
      match: matchProposal,
      differ: differProposal,
    });

    res.json({
      analytics,
      volatility,
      contractSupport: contractSupport ?? {
        symbol,
        supportedTypes: [],
        supportsDigits: true,
        supportsMatch: true,
        supportsDiffer: true,
        supportsOverUnder: true,
        supportsEvenOdd: true,
        supportsRiseFall: true,
        minDurationTicks: 1,
        maxDurationTicks: 10,
        checkedAt: new Date().toISOString(),
      },
      proposals: {
        match: matchProposal,
        differ: differProposal,
        stake,
        durationTicks,
      },
      ...candidates,
      feedHealth: {
        connectionState: 'BROWSER_WS_LIVE',
        isConnected: true,
        isStale: volatility.isStale,
        ageSeconds: volatility.staleSeconds,
        lastMessageAt: volatility.asOfTimestamp,
      },
    });
  });

  // ---------------- QUANTITATIVE ANALYSIS, SCANNER, BACKTEST ----------------

  app.post('/api/v1/quant/analyze', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframe: z.string().default('M15'),
        count: z.number().int().min(35).max(2000).default(300),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_ANALYSIS_REQUEST' });
      return;
    }
    try {
      const candles = await derivPublic.fetchCandles(
        parsed.data.symbol,
        TIMEFRAMES[parsed.data.timeframe],
        parsed.data.count
      );
      const calibration = previewStore.activeCalibration[parsed.data.timeframe] ?? null;
      const result = analyzeCandles(parsed.data.symbol, parsed.data.timeframe, candles, calibration);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Quant analysis failed' });
    }
  });

  app.post('/api/v1/quant/compute', (req: Request, res: Response) => {
    const candleSchema = z.object({
      epoch: z.number(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
    });
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframe: z.string().default('M15'),
        candles: z.array(candleSchema).min(35).max(2000),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_QUANT_COMPUTE_PAYLOAD' });
      return;
    }
    const calibration = previewStore.activeCalibration[parsed.data.timeframe] ?? null;
    const result = analyzeCandles(parsed.data.symbol, parsed.data.timeframe, parsed.data.candles, calibration);
    res.json(result);
  });

  app.post('/api/v1/quant/multi-timeframe', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframes: z.array(z.string()).min(1).max(7).default(['M5', 'M15', 'H1', 'H4']),
        count: z.number().int().min(35).max(1000).default(250),
      })
      .safeParse(req.body);
    if (!parsed.success || parsed.data.timeframes.some((tf) => !TIMEFRAMES[tf])) {
      res.status(400).json({ error: 'INVALID_MULTI_TIMEFRAME_REQUEST' });
      return;
    }
    try {
      const candlesByTf: Record<string, any[]> = {};
      await Promise.all(
        parsed.data.timeframes.map(async (tf) => {
          candlesByTf[tf] = await derivPublic.fetchCandles(parsed.data.symbol, TIMEFRAMES[tf], parsed.data.count);
        })
      );
      res.json(multiTimeframeAnalysis(parsed.data.symbol, candlesByTf, previewStore.activeCalibration));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Multi-timeframe analysis failed' });
    }
  });

  app.post('/api/v1/quant/scan', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        symbols: z.array(z.string().regex(SYMBOL_REGEX)).min(1).max(60),
        timeframe: z.string().default('M15'),
        count: z.number().int().min(40).max(500).default(150),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_SCAN_REQUEST' });
      return;
    }

    const unique = Array.from(new Set(parsed.data.symbols));
    const results: Array<QuantAnalysisResult | { symbol: string; timeframe: string; direction: 'ERROR'; error: string }> = [];
    const concurrency = 4;

    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const batchRes = await Promise.all(
        batch.map(async (sym) => {
          try {
            const candles = await derivPublic.fetchCandles(
              sym,
              TIMEFRAMES[parsed.data.timeframe],
              parsed.data.count
            );
            return analyzeCandles(
              sym,
              parsed.data.timeframe,
              candles,
              previewStore.activeCalibration[parsed.data.timeframe] ?? null
            );
          } catch (err) {
            return {
              symbol: sym,
              timeframe: parsed.data.timeframe,
              direction: 'ERROR' as const,
              error: err instanceof Error ? err.message : 'Scan failed',
            };
          }
        })
      );
      results.push(...batchRes);
    }

    results.sort((a, b) => {
      const ca = 'calibrated_confidence' in a ? a.calibrated_confidence : 0;
      const cb = 'calibrated_confidence' in b ? b.calibrated_confidence : 0;
      return cb - ca;
    });
    res.json({
      scanned: results.length,
      timeframe: parsed.data.timeframe,
      scannedAt: new Date().toISOString(),
      results,
    });
  });

  app.post('/api/v1/quant/backtest', async (req: Request, res: Response) => {
    const candleSchema = z.object({
      epoch: z.number(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
    });
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframe: z.string().default('M15'),
        count: z.number().int().min(60).max(2000).default(400),
        initial_equity: z.number().positive().max(10_000_000).default(10000),
        risk_fraction: z.number().positive().max(0.02).default(0.005),
        fee_rate: z.number().min(0).max(0.05).default(0.0002),
        slippage_bps: z.number().min(0).max(500).default(2),
        threshold: z.number().min(0.1).max(0.95).default(0.35),
        candles: z.array(candleSchema).min(60).max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_BACKTEST_CONFIG' });
      return;
    }
    try {
      const candles =
        parsed.data.candles ??
        (await derivPublic.fetchCandles(
          parsed.data.symbol,
          TIMEFRAMES[parsed.data.timeframe],
          parsed.data.count
        ));
      const output = runBacktest(parsed.data.symbol, parsed.data.timeframe, candles, {
        initial_equity: parsed.data.initial_equity,
        risk_fraction: parsed.data.risk_fraction,
        fee_rate: parsed.data.fee_rate,
        slippage_bps: parsed.data.slippage_bps,
        threshold: parsed.data.threshold,
      });
      res.json(output);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Backtest failed' });
    }
  });

  app.post('/api/v1/quant/walk-forward', async (req: Request, res: Response) => {
    const candleSchema = z.object({
      epoch: z.number(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
    });
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframe: z.string().default('M15'),
        count: z.number().int().min(160).max(2000).default(600),
        train_size: z.number().int().min(80).default(240),
        test_size: z.number().int().min(36).default(80),
        step: z.number().int().min(10).default(80),
        candles: z.array(candleSchema).min(160).max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_WALK_FORWARD_CONFIG' });
      return;
    }
    try {
      const candles =
        parsed.data.candles ??
        (await derivPublic.fetchCandles(
          parsed.data.symbol,
          TIMEFRAMES[parsed.data.timeframe],
          parsed.data.count
        ));
      res.json(
        walkForwardValidation(
          parsed.data.symbol,
          parsed.data.timeframe,
          candles,
          parsed.data.train_size,
          parsed.data.test_size,
          parsed.data.step
        )
      );
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Walk-forward failed' });
    }
  });

  app.post('/api/v1/quant/calibration/fit', (req: Request, res: Response) => {
    const parsed = z
      .object({
        timeframe: z.string(),
        observations: z
          .array(z.object({ confidence: z.number().gt(0).lt(1), outcome: z.union([z.literal(0), z.literal(1)]) }))
          .min(30),
      })
      .safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_CALIBRATION_OBSERVATIONS' });
      return;
    }
    try {
      const fit = fitPlattCalibration(parsed.data.observations);
      previewStore.activeCalibration[parsed.data.timeframe] = fit;
      res.json({ ...fit, timeframe: parsed.data.timeframe, status: 'ACTIVE' });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Calibration fit failed' });
    }
  });

  // ---------------- PAPER TRADING LABORATORY ----------------

  app.get('/api/v1/paper/account', (_req: Request, res: Response) => {
    const acc = previewStore.paperAccount;
    const closed = previewStore.positions.filter((p) => p.status === 'WON' || p.status === 'LOST');
    const wins = closed.filter((p) => p.status === 'WON');
    const losses = closed.filter((p) => p.status === 'LOST');
    const netProfitCents = closed.reduce((sum, p) => sum + toCents(p.profit_loss ?? 0), 0);
    const grossProfit = wins.reduce((s, p) => s + (p.profit_loss ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + (p.profit_loss ?? 0), 0));
    let equity = acc.starting_equity;
    let peak = equity;
    let maxDd = 0;
    for (const p of [...closed].reverse()) {
      equity += p.profit_loss ?? 0;
      peak = Math.max(peak, equity);
      if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
    }

    res.json({
      ...acc,
      available_balance: fromCents(toCents(acc.current_equity) - toCents(acc.reserved_stake)),
      execution: 'PAPER_ONLY',
      metrics: {
        closed_trades: closed.length,
        open_trades: previewStore.positions.filter((p) => p.status === 'OPEN').length,
        wins: wins.length,
        losses: losses.length,
        win_rate: closed.length ? Number((wins.length / closed.length).toFixed(4)) : 0,
        net_profit: fromCents(netProfitCents),
        profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit > 0 ? 'infinite' : 0,
        max_drawdown: Number(maxDd.toFixed(6)),
      },
    });
  });

  app.get('/api/v1/paper/positions', (req: Request, res: Response) => {
    const statusFilter = String(req.query.status || 'ALL');
    const list =
      statusFilter === 'ALL'
        ? previewStore.positions
        : previewStore.positions.filter((p) => p.status === statusFilter);
    res.json({ positions: list.slice(0, 100) });
  });

  app.post('/api/v1/paper/trades', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        timeframe: z.string().default('M1'),
        contractType: z.enum(['CALL', 'PUT', 'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD']).default('CALL'),
        barrier: z.string().optional(),
        direction: z.enum(['BUY', 'SELL']).default('BUY'),
        stake: z.number().positive(),
        expiry_seconds: z.number().int().min(1).max(86400).default(10),
        payout_multiplier: z.number().positive().max(10).default(0.85),
        strategy_id: z.number().int().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAPER_ORDER', details: parsed.error.flatten() });
      return;
    }
    try {
      const acc = previewStore.paperAccount;
      const openPositions = previewStore.positions.filter((p) => p.status === 'OPEN').length;
      const todayUtc = new Date().toISOString().slice(0, 10);
      const dailyRealizedPnl = previewStore.positions
        .filter((p) => p.settled_at && p.settled_at.startsWith(todayUtc) && (p.status === 'WON' || p.status === 'LOST'))
        .reduce((sum, p) => sum + (p.profit_loss ?? 0), 0);

      validatePaperOrder({
        equity: acc.current_equity,
        availableBalance: fromCents(toCents(acc.current_equity) - toCents(acc.reserved_stake)),
        stake: parsed.data.stake,
        expirySeconds: parsed.data.expiry_seconds,
        openPositions,
        dailyRealizedPnl,
      });

      const tick = await derivPublic.getLatestTick(parsed.data.symbol);
      const openedAt = new Date();
      const expiresAt = new Date(openedAt.getTime() + parsed.data.expiry_seconds * 1000);
      const pos = {
        position_id: previewStore.nextPositionId++,
        paper_account_id: acc.paper_account_id,
        strategy_id: parsed.data.strategy_id ?? null,
        symbol_code: parsed.data.symbol,
        timeframe: parsed.data.timeframe,
        contract_type: parsed.data.contractType,
        barrier: parsed.data.barrier ?? null,
        direction: parsed.data.direction,
        stake: Number(parsed.data.stake.toFixed(2)),
        payout_multiplier: parsed.data.payout_multiplier,
        entry_price: tick.quote,
        entry_quote_str: tick.rawQuote,
        exit_price: null,
        exit_quote_str: null,
        opened_at: openedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        settled_at: null,
        status: 'OPEN' as const,
        profit_loss: null,
        signal_snapshot: { latestDigit: tick.lastDigit, epoch: tick.epoch },
      };

      acc.reserved_stake = fromCents(toCents(acc.reserved_stake) + toCents(pos.stake));
      previewStore.positions.unshift(pos);

      res.status(201).json({
        position: pos,
        execution: 'PAPER_ONLY',
        note: 'Simulated virtual funds on genuine Deriv market feed. Payout multiplier is simulated unless fetched from a live Deriv proposal.',
      });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Unable to open paper trade' });
    }
  });

  app.post('/api/v1/paper/positions/:positionId/settle', async (req: Request, res: Response) => {
    const id = Number(req.params.positionId);
    const pos = previewStore.positions.find((p) => p.position_id === id);
    if (!pos) {
      res.status(404).json({ error: 'PAPER_POSITION_NOT_FOUND' });
      return;
    }
    if (pos.status !== 'OPEN') {
      res.json({ position: pos });
      return;
    }
    if (Date.now() < new Date(pos.expires_at).getTime()) {
      res.status(409).json({ error: 'Position has not reached expiry yet' });
      return;
    }

    try {
      const tick = await derivPublic.getLatestTick(pos.symbol_code);
      let won = false;
      const d = tick.lastDigit;
      const barrierNum = pos.barrier !== null ? Number(pos.barrier) : 0;

      switch (pos.contract_type) {
        case 'DIGITMATCH':
          won = d === barrierNum;
          break;
        case 'DIGITDIFF':
          won = d !== barrierNum;
          break;
        case 'DIGITOVER':
          won = d > barrierNum;
          break;
        case 'DIGITUNDER':
          won = d < barrierNum;
          break;
        case 'DIGITEVEN':
          won = d % 2 === 0;
          break;
        case 'DIGITODD':
          won = d % 2 === 1;
          break;
        case 'PUT':
          won = tick.quote < pos.entry_price;
          break;
        default:
          won = pos.direction === 'BUY' ? tick.quote > pos.entry_price : tick.quote < pos.entry_price;
      }

      const pnlCents = won ? Math.round(toCents(pos.stake) * pos.payout_multiplier) : -toCents(pos.stake);
      const pnl = fromCents(pnlCents);
      pos.exit_price = tick.quote;
      pos.exit_quote_str = tick.rawQuote;
      pos.settled_at = new Date().toISOString();
      pos.status = won ? 'WON' : 'LOST';
      pos.profit_loss = pnl;

      const acc = previewStore.paperAccount;
      acc.current_equity = fromCents(toCents(acc.current_equity) + pnlCents);
      acc.reserved_stake = fromCents(Math.max(0, toCents(acc.reserved_stake) - toCents(pos.stake)));

      // Update bounded recovery session tracking
      const rec = previewStore.recoveryPolicy;
      rec.session_realized_pnl = fromCents(toCents(rec.session_realized_pnl) + pnlCents);
      if (won) {
        rec.consecutive_losses = 0;
      } else {
        rec.consecutive_losses += 1;
        if (rec.mode !== 'OFF') {
          rec.cooldown_until = new Date(Date.now() + rec.cooldown_seconds * 1000).toISOString();
        }
      }

      res.json({ position: pos, account: acc });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to obtain settlement tick' });
    }
  });

  // ---------------- STRATEGY BUILDER & PAPER AUTOMATION ----------------

  app.get('/api/v1/paper/strategies', (_req: Request, res: Response) => {
    res.json({ strategies: previewStore.strategies });
  });

  app.post('/api/v1/paper/strategies', (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(2).max(120),
      description: z.string().max(1000).default(''),
      symbol: z.string().regex(SYMBOL_REGEX),
      timeframe: z.string().default('M15'),
      contract_family: z.enum(['CALL_PUT', 'DIGITMATCH', 'DIGITDIFF', 'DIGITOVER_UNDER', 'DIGITEVEN_ODD']).default('CALL_PUT'),
      parameters: z.record(z.string(), z.unknown()).default({}),
      blocks: z.record(z.string(), z.unknown()).default({}),
      enabled: z.boolean().default(false),
      auto_enabled: z.boolean().default(false),
      risk_fraction: z.number().positive().max(0.02).default(0.005),
      expiry_seconds: z.number().int().min(5).max(86400).default(300),
      payout_multiplier: z.number().positive().max(10).default(0.85),
      min_confidence: z.number().min(0).max(1).default(0.65),
      cooldown_seconds: z.number().int().min(10).max(86400).default(300),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || !TIMEFRAMES[parsed.data.timeframe]) {
      res.status(400).json({ error: 'INVALID_STRATEGY_GRAPH', details: parsed.error?.flatten() });
      return;
    }

    const record = {
      strategy_id: previewStore.nextStrategyId++,
      name: parsed.data.name,
      description: parsed.data.description,
      symbol_code: parsed.data.symbol,
      timeframe: parsed.data.timeframe,
      contract_family: parsed.data.contract_family,
      parameters: parsed.data.parameters,
      blocks: parsed.data.blocks,
      enabled: parsed.data.enabled,
      auto_enabled: parsed.data.auto_enabled && parsed.data.enabled,
      risk_fraction: parsed.data.risk_fraction,
      expiry_seconds: parsed.data.expiry_seconds,
      payout_multiplier: parsed.data.payout_multiplier,
      min_confidence: parsed.data.min_confidence,
      cooldown_seconds: parsed.data.cooldown_seconds,
      last_evaluated_at: null,
      created_at: new Date().toISOString(),
    };
    previewStore.strategies.unshift(record);
    res.status(201).json({ strategy: record, execution_mode: 'PAPER' });
  });

  app.post('/api/v1/automation/strategies/:id/toggle', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = z.object({ enabled: z.boolean(), auto_enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_TOGGLE' });
      return;
    }
    const strat = previewStore.strategies.find((s) => s.strategy_id === id);
    if (!strat) {
      res.status(404).json({ error: 'STRATEGY_NOT_FOUND' });
      return;
    }
    strat.enabled = parsed.data.enabled;
    strat.auto_enabled = parsed.data.enabled && parsed.data.auto_enabled;
    res.json({ strategy: strat });
  });

  app.get('/api/v1/automation/status', (_req: Request, res: Response) => {
    res.json({
      control: previewStore.automationControl,
      active_strategies: previewStore.strategies.filter((s) => s.enabled && s.auto_enabled).length,
      total_strategies: previewStore.strategies.length,
      alerts: previewStore.alerts.slice(0, 30),
      unacknowledged_alerts: previewStore.alerts.filter((a) => !a.acknowledged_at).length,
      last_run_at: previewStore.lastRunAt,
      mode: 'PAPER_ONLY',
    });
  });

  app.post('/api/v1/automation/control', (req: Request, res: Response) => {
    const parsed = z
      .object({
        enabled: z.boolean(),
        kill_switch: z.boolean(),
        reason: z.string().max(300).default(''),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_AUTOMATION_CONTROL' });
      return;
    }
    const effectiveEnabled = parsed.data.enabled && !parsed.data.kill_switch;
    previewStore.automationControl = {
      enabled: effectiveEnabled,
      kill_switch: parsed.data.kill_switch,
      paused_reason: parsed.data.reason || (effectiveEnabled ? null : 'Paused by operator'),
      updated_at: new Date().toISOString(),
    };
    previewStore.alerts.unshift({
      alert_id: previewStore.nextAlertId++,
      severity: parsed.data.kill_switch ? 'WARNING' : 'INFO',
      alert_code: 'AUTOMATION_CONTROL_UPDATED',
      message: effectiveEnabled ? 'Paper automation enabled' : 'Paper automation paused',
      acknowledged_at: null,
      created_at: new Date().toISOString(),
    });
    res.json({ control: previewStore.automationControl });
  });

  async function runAutomationCycleInternal() {
    previewStore.lastRunAt = new Date().toISOString();
    const ctrl = previewStore.automationControl;
    if (!ctrl.enabled || ctrl.kill_switch) {
      return { executed: 0, settled: 0, skippedReason: 'Automation paused or kill switch active' };
    }

    // Settle any expired paper trades first
    let settledCount = 0;
    const nowMs = Date.now();
    for (const pos of previewStore.positions) {
      if (pos.status === 'OPEN' && new Date(pos.expires_at).getTime() <= nowMs) {
        try {
          const tick = await derivPublic.getLatestTick(pos.symbol_code);
          const won = pos.direction === 'BUY' ? tick.quote > pos.entry_price : tick.quote < pos.entry_price;
          const pnlCents = won ? Math.round(toCents(pos.stake) * pos.payout_multiplier) : -toCents(pos.stake);
          pos.exit_price = tick.quote;
          pos.exit_quote_str = tick.rawQuote;
          pos.settled_at = new Date().toISOString();
          pos.status = won ? 'WON' : 'LOST';
          pos.profit_loss = fromCents(pnlCents);
          previewStore.paperAccount.current_equity = fromCents(toCents(previewStore.paperAccount.current_equity) + pnlCents);
          previewStore.paperAccount.reserved_stake = fromCents(
            Math.max(0, toCents(previewStore.paperAccount.reserved_stake) - toCents(pos.stake))
          );
          settledCount += 1;
        } catch {
          // leave open if settlement tick unavailable
        }
      }
    }

    let openedCount = 0;
    const activeStrategies = previewStore.strategies.filter((s) => s.enabled && s.auto_enabled);
    for (const strat of activeStrategies) {
      try {
        const candles = await derivPublic.fetchCandles(strat.symbol_code, TIMEFRAMES[strat.timeframe] || 900, 120);
        const analysis = analyzeCandles(strat.symbol_code, strat.timeframe, candles);
        strat.last_evaluated_at = new Date().toISOString();
        if (analysis.direction !== 'NEUTRAL' && analysis.calibrated_confidence >= strat.min_confidence) {
          const stake = Math.max(0.35, Number((previewStore.paperAccount.current_equity * strat.risk_fraction).toFixed(2)));
          validatePaperOrder({
            equity: previewStore.paperAccount.current_equity,
            availableBalance: fromCents(
              toCents(previewStore.paperAccount.current_equity) - toCents(previewStore.paperAccount.reserved_stake)
            ),
            stake,
            expirySeconds: strat.expiry_seconds,
            openPositions: previewStore.positions.filter((p) => p.status === 'OPEN').length,
            dailyRealizedPnl: 0,
          });
          const tick = await derivPublic.getLatestTick(strat.symbol_code);
          previewStore.paperAccount.reserved_stake = fromCents(
            toCents(previewStore.paperAccount.reserved_stake) + toCents(stake)
          );
          previewStore.positions.unshift({
            position_id: previewStore.nextPositionId++,
            paper_account_id: 1,
            strategy_id: strat.strategy_id,
            symbol_code: strat.symbol_code,
            timeframe: strat.timeframe,
            contract_type: analysis.direction === 'BUY' ? 'CALL' : 'PUT',
            barrier: null,
            direction: analysis.direction,
            stake,
            payout_multiplier: strat.payout_multiplier,
            entry_price: tick.quote,
            entry_quote_str: tick.rawQuote,
            exit_price: null,
            exit_quote_str: null,
            opened_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + strat.expiry_seconds * 1000).toISOString(),
            settled_at: null,
            status: 'OPEN',
            profit_loss: null,
            signal_snapshot: { score: analysis.score, regime: analysis.regime },
          });
          openedCount += 1;
        }
      } catch {
        // isolate per-strategy error
      }
    }

    return { executed: openedCount, settled: settledCount, evaluatedAt: previewStore.lastRunAt };
  }

  app.post('/api/v1/automation/run-once', async (_req: Request, res: Response) => {
    const summary = await runAutomationCycleInternal();
    res.json(summary);
  });

  app.post('/api/v1/automation/alerts/:id/acknowledge', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const alert = previewStore.alerts.find((a) => a.alert_id === id);
    if (!alert) {
      res.status(404).json({ error: 'ALERT_NOT_FOUND' });
      return;
    }
    alert.acknowledged_at = new Date().toISOString();
    res.json({ alert });
  });

  app.get('/api/cron/automation', async (req: Request, res: Response) => {
    const auth = req.headers.authorization || '';
    if (serverConfig.cronSecret && auth !== `Bearer ${serverConfig.cronSecret}`) {
      res.status(401).json({ error: 'INVALID_CRON_SECRET' });
      return;
    }
    const summary = await runAutomationCycleInternal();
    res.json({ ok: true, ...summary });
  });

  // ---------------- BOUNDED LOSS RECOVERY CONTROLLER ----------------

  app.get('/api/v1/risk/recovery', (_req: Request, res: Response) => {
    const p = previewStore.recoveryPolicy;
    const worstCaseCappedLoss = Number(Math.min(p.max_session_loss, p.max_attempts_session * p.max_stake).toFixed(2));
    res.json({
      policy: p,
      worstCaseAdditionalLossPreview: worstCaseCappedLoss,
      unlimitedMartingaleAllowed: false,
      deploymentRecoveryFlag: serverConfig.recoveryEnabled,
    });
  });

  app.post('/api/v1/risk/recovery', (req: Request, res: Response) => {
    const schema = z.object({
      mode: z.enum(['OFF', 'COOLDOWN', 'FIXED_STAKE_REASSESSMENT', 'LIMITED_RECOVERY_PLAN']),
      real_account_opt_in: z.boolean().default(false),
      max_attempts_session: z.number().int().min(0).max(5),
      cooldown_seconds: z.number().int().min(10).max(3600),
      max_stake: z.number().positive().max(serverConfig.liveMaxStake * 10),
      max_balance_percent: z.number().positive().max(5),
      max_session_loss: z.number().positive().max(500),
      max_daily_loss: z.number().positive().max(500),
      max_drawdown_percent: z.number().positive().max(25),
      max_consecutive_losses: z.number().int().min(1).max(10),
      max_open_contracts: z.number().int().min(1).max(5),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_BOUNDED_RECOVERY_POLICY', details: parsed.error.flatten() });
      return;
    }
    previewStore.recoveryPolicy = {
      ...previewStore.recoveryPolicy,
      ...parsed.data,
      // Real account recovery stays disabled unless server env allows it AND user explicitly opts in
      real_account_opt_in: serverConfig.recoveryEnabled && parsed.data.real_account_opt_in,
    };
    const p = previewStore.recoveryPolicy;
    res.json({
      policy: p,
      worstCaseAdditionalLossPreview: Number(Math.min(p.max_session_loss, p.max_attempts_session * p.max_stake).toFixed(2)),
    });
  });

  // ---------------- DERIV OAUTH & CONTROLLED LIVE EXECUTION ----------------

  const DERIV_OAUTH_TX_COOKIE = 'dqi_deriv_oauth_tx';
  const DERIV_OAUTH_SESSION_COOKIE = 'dqi_deriv_oauth_session';

  interface StoredDerivOAuthSession {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    clientId: string;
    activeAccountId?: string;
  }

  interface DerivV2AccountItem {
    accountId: string;
    accountType: 'demo' | 'real';
    isVirtual: boolean;
    currency: string;
    balance: number | null;
    status: string;
  }

  function readDerivOAuthSession(req: Request): StoredDerivOAuthSession | null {
    const raw = req.cookies?.[DERIV_OAUTH_SESSION_COOKIE];
    if (!raw || typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(decryptSecret(raw)) as StoredDerivOAuthSession;
      if (!parsed?.accessToken) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveDerivOAuthSession(res: Response, req: Request, sess: StoredDerivOAuthSession): void {
    const encrypted = encryptSecret(JSON.stringify(sess));
    setAuthCookie(res, DERIV_OAUTH_SESSION_COOKIE, encrypted, 28800, req);
  }

  async function refreshDerivOAuthIfNeeded(
    sess: StoredDerivOAuthSession,
    res: Response,
    req: Request
  ): Promise<StoredDerivOAuthSession> {
    if (sess.expiresAt > Date.now() + 60_000 || !sess.refreshToken) {
      return sess;
    }
    try {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: sess.clientId || serverConfig.derivClientId,
        refresh_token: sess.refreshToken,
      });
      const resp = await fetch(new URL('/oauth2/token', serverConfig.derivAuthBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form,
      });
      if (!resp.ok) return sess;
      const data = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) return sess;
      const updated: StoredDerivOAuthSession = {
        ...sess,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || sess.refreshToken,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      };
      saveDerivOAuthSession(res, req, updated);
      return updated;
    } catch {
      return sess;
    }
  }

  async function fetchDerivOptionsAccounts(
    accessToken: string,
    clientId: string
  ): Promise<DerivV2AccountItem[]> {
    const url = new URL('/trading/v1/options/accounts', serverConfig.derivApiBaseUrl);
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Deriv-App-ID': clientId,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Deriv accounts request failed (HTTP ${resp.status}): ${errText.slice(0, 180)}`);
    }
    const payload = (await resp.json()) as {
      data?: Array<Record<string, unknown>>;
      accounts?: Array<Record<string, unknown>>;
    };
    const rows = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.accounts)
      ? payload.accounts
      : [];
    return rows
      .map((r) => {
        const accountId = String(r.account_id || r.loginid || r.id || '');
        const rawType = String(r.account_type || r.type || '').toLowerCase();
        const isVirtual =
          rawType === 'demo' ||
          Boolean(r.is_virtual) ||
          accountId.startsWith('VRTC') ||
          accountId.startsWith('DOT');
        const rawBal = r.balance;
        const balance =
          typeof rawBal === 'number'
            ? rawBal
            : typeof rawBal === 'string' && rawBal !== '' && Number.isFinite(Number(rawBal))
            ? Number(rawBal)
            : null;
        return {
          accountId,
          accountType: (isVirtual ? 'demo' : 'real') as 'demo' | 'real',
          isVirtual,
          currency: String(r.currency || 'USD'),
          balance,
          status: String(r.status || 'enabled'),
        };
      })
      .filter((a) => Boolean(a.accountId));
  }

  async function createDerivOptionsOtp(
    accessToken: string,
    clientId: string,
    accountId: string
  ): Promise<{ url: string; expiresAt: number | null }> {
    const url = new URL(
      `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      serverConfig.derivApiBaseUrl
    );
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Deriv-App-ID': clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Deriv OTP creation failed (HTTP ${resp.status}): ${errText.slice(0, 180)}`);
    }
    const payload = (await resp.json()) as {
      data?: { url?: string; expires_at?: number };
      url?: string;
      expires_at?: number;
    };
    const wsUrl = payload.data?.url || payload.url;
    if (!wsUrl) throw new Error('Deriv OTP endpoint did not return a WebSocket URL');
    return {
      url: wsUrl,
      expiresAt: payload.data?.expires_at ?? payload.expires_at ?? null,
    };
  }

  async function fetchOtpBalance(otpWsUrl: string): Promise<{ balance: number | null; currency?: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(otpWsUrl, { handshakeTimeout: 4500, perMessageDeflate: false });
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve({ balance: null });
      }, 5000);
      ws.once('open', () => {
        ws.send(JSON.stringify({ balance: 1, req_id: 1 }));
      });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            balance?: { balance?: number; currency?: string };
            error?: unknown;
          };
          if (msg.balance && typeof msg.balance.balance === 'number') {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve({ balance: Number(msg.balance.balance), currency: msg.balance.currency });
          } else if (msg.error) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve({ balance: null });
          }
        } catch {
          // ignore parse errors
        }
      });
      ws.once('error', () => {
        clearTimeout(timer);
        resolve({ balance: null });
      });
    });
  }

  async function hydrateAccountsWithBalances(
    accessToken: string,
    clientId: string,
    accounts: DerivV2AccountItem[]
  ): Promise<DerivV2AccountItem[]> {
    const primaryDemo = accounts.find((a) => a.isVirtual && a.currency === 'USD') || accounts.find((a) => a.isVirtual);
    const primaryReal = accounts.find((a) => !a.isVirtual && a.currency === 'USD') || accounts.find((a) => !a.isVirtual);
    const targets = [primaryDemo, primaryReal].filter((a): a is DerivV2AccountItem => Boolean(a));

    await Promise.all(
      targets.map(async (acct) => {
        if (acct.balance !== null) return;
        try {
          const otp = await createDerivOptionsOtp(accessToken, clientId, acct.accountId);
          const bal = await fetchOtpBalance(otp.url);
          if (bal.balance !== null) {
            acct.balance = bal.balance;
          }
          if (bal.currency) {
            acct.currency = bal.currency;
          }
        } catch {
          // keep null if account OTP unavailable
        }
      })
    );
    return accounts;
  }

  app.get('/api/v1/auth/deriv/status', (req: Request, res: Response) => {
    const sess = readDerivOAuthSession(req);
    const clientId = serverConfig.derivClientId;
    res.json({
      configured: isDerivOAuthConfigured(),
      customAppConfigured: true,
      connected: Boolean(sess),
      appId: clientId,
      redirectUri: serverConfig.derivRedirectUri,
      redirectUriConfigured: Boolean(serverConfig.derivRedirectUri),
      clientIdConfigured: Boolean(clientId),
      scopes: serverConfig.derivOAuthScopes,
      message: `Ready for Deriv OAuth (App ID ${clientId}).`,
    });
  });

  app.get('/api/v1/auth/deriv/start', (req: Request, res: Response) => {
    const clientId = serverConfig.derivClientId;
    const redirectUri = serverConfig.derivRedirectUri;
    const reqAppId = String(req.query.app_id || '').trim();
    const useLegacyNumeric = /^\d+$/.test(reqAppId) && reqAppId !== clientId;

    if (useLegacyNumeric) {
      const legacyUrl = new URL('/oauth2/authorize', 'https://oauth.deriv.com');
      legacyUrl.searchParams.set('app_id', reqAppId);
      legacyUrl.searchParams.set('l', 'EN');
      legacyUrl.searchParams.set('brand', 'deriv');
      res.json({ authorizationUrl: legacyUrl.toString(), appId: reqAppId, redirectUri });
      return;
    }

    const state = randomToken(24);
    const verifier = randomToken(32);
    const challenge = pkceChallenge(verifier);
    const encVerifier = encryptSecret(verifier);
    const expiresAt = Date.now() + 10 * 60 * 1000;

    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const returnOrigin = host ? `${proto}://${Array.isArray(host) ? host[0] : host}` : serverConfig.appUrl;

    previewStore.oauthTransactions.set(sha256(state), {
      verifier: encVerifier,
      redirectUri,
      expiresAt,
    });

    // Also persist encrypted PKCE transaction in HttpOnly cookie so Vercel serverless callbacks validate reliably
    const txCookie = encryptSecret(
      JSON.stringify({ state, verifier, redirectUri, clientId, returnOrigin, expiresAt })
    );
    setAuthCookie(res, DERIV_OAUTH_TX_COOKIE, txCookie, 600, req);

    const authBase = serverConfig.derivAuthBaseUrl || 'https://auth.deriv.com';
    const url = new URL('/oauth2/auth', authBase);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', serverConfig.derivOAuthScopes || 'trade account_manage');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    res.json({
      authorizationUrl: url.toString(),
      appId: clientId,
      redirectUri,
      scopes: serverConfig.derivOAuthScopes,
    });
  });

  app.get('/api/v1/auth/deriv/callback', async (req: Request, res: Response) => {
    // Handle legacy Deriv multi-account OAuth callback (?acct1=...&token1=...&cur1=...) if received
    if (req.query.acct1 && req.query.token1) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === 'string') qs.set(k, v);
      }
      res.redirect(`/?${qs.toString()}`);
      return;
    }

    const oauthErr = String(req.query.error_description || req.query.error || '');
    if (oauthErr) {
      res.redirect(`/?oauth_error=${encodeURIComponent(oauthErr)}`);
      return;
    }

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state) {
      res.redirect('/?oauth_error=Missing+Deriv+OAuth+authorization+code+or+state');
      return;
    }

    // Resolve PKCE transaction from memory store OR encrypted serverless cookie
    let verifier: string | null = null;
    let redirectUri = serverConfig.derivRedirectUri;
    let clientId = serverConfig.derivClientId;

    const txKey = sha256(state);
    const memTx = previewStore.oauthTransactions.get(txKey);
    if (memTx && memTx.expiresAt > Date.now()) {
      previewStore.oauthTransactions.delete(txKey);
      try {
        verifier = decryptSecret(memTx.verifier);
        redirectUri = memTx.redirectUri;
      } catch {
        verifier = null;
      }
    }

    if (!verifier && req.cookies?.[DERIV_OAUTH_TX_COOKIE]) {
      try {
        const cookieTx = JSON.parse(decryptSecret(String(req.cookies[DERIV_OAUTH_TX_COOKIE]))) as {
          state?: string;
          verifier?: string;
          redirectUri?: string;
          clientId?: string;
          expiresAt?: number;
        };
        if (cookieTx.state === state && (cookieTx.expiresAt ?? 0) > Date.now() && cookieTx.verifier) {
          verifier = cookieTx.verifier;
          if (cookieTx.redirectUri) redirectUri = cookieTx.redirectUri;
          if (cookieTx.clientId) clientId = cookieTx.clientId;
        }
      } catch {
        verifier = null;
      }
    }

    clearAuthCookie(res, DERIV_OAUTH_TX_COOKIE, req);

    if (!verifier) {
      res.redirect('/?oauth_error=OAuth+session+expired.+Please+click+Continue+with+Deriv+OAuth+again.');
      return;
    }

    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
      const tokenResp = await fetch(new URL('/oauth2/token', serverConfig.derivAuthBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form,
      });
      if (!tokenResp.ok) {
        const errBody = await tokenResp.text().catch(() => '');
        res.redirect(
          `/?oauth_error=${encodeURIComponent(`Deriv token exchange failed (${tokenResp.status}): ${errBody.slice(0, 100)}`)}`
        );
        return;
      }
      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!tokenData.access_token) {
        res.redirect('/?oauth_error=Deriv+returned+no+access_token');
        return;
      }

      const sessionPayload: StoredDerivOAuthSession = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
        clientId,
      };
      saveDerivOAuthSession(res, req, sessionPayload);

      const pool = getPool();
      if (pool) {
        const encrypted = encryptSecret(tokenData.access_token);
        const user = await pool.query("SELECT user_id FROM app_users WHERE email='dqi-operator@localhost' LIMIT 1");
        if (user.rowCount) {
          await pool.query(
            `INSERT INTO deriv_credentials(owner_user_id, auth_method, encrypted_access_token, token_expires_at, scopes)
             VALUES($1, 'OAUTH2', $2, now() + ($3 * interval '1 second'), $4)`,
            [user.rows[0].user_id, encrypted, Number(tokenData.expires_in || 3600), serverConfig.derivOAuthScopes.split(/\s+/)]
          );
        }
      }

      res.redirect('/?deriv=connected');
    } catch (err) {
      res.redirect(
        `/?oauth_error=${encodeURIComponent(err instanceof Error ? err.message : 'Deriv OAuth callback failed')}`
      );
    }
  });

  app.get('/api/v1/auth/deriv/session', async (req: Request, res: Response) => {
    const existing = readDerivOAuthSession(req);
    if (!existing) {
      res.json({ connected: false, appId: serverConfig.derivClientId, accounts: [] });
      return;
    }
    try {
      const sess = await refreshDerivOAuthIfNeeded(existing, res, req);
      const rawAccounts = await fetchDerivOptionsAccounts(sess.accessToken, sess.clientId);
      const accounts = await hydrateAccountsWithBalances(sess.accessToken, sess.clientId, rawAccounts);
      const preferred =
        (sess.activeAccountId && accounts.find((a) => a.accountId === sess.activeAccountId)) ||
        accounts.find((a) => a.isVirtual && a.currency === 'USD') ||
        accounts.find((a) => a.isVirtual) ||
        accounts[0] ||
        null;

      if (preferred && preferred.accountId !== sess.activeAccountId) {
        saveDerivOAuthSession(res, req, { ...sess, activeAccountId: preferred.accountId });
      }

      res.json({
        connected: accounts.length > 0,
        authMode: 'OAUTH2_V2',
        appId: sess.clientId,
        activeLoginId: preferred?.accountId ?? null,
        activeIsVirtual: preferred?.isVirtual ?? true,
        activeCurrency: preferred?.currency ?? 'USD',
        activeBalance: preferred?.balance ?? null,
        scopes: serverConfig.derivOAuthScopes.split(/\s+/),
        accounts: accounts.map((a) => ({
          loginid: a.accountId,
          currency: a.currency,
          isVirtual: a.isVirtual,
          balance: a.balance,
          hasToken: true,
          accountCategory: a.accountType,
        })),
      });
    } catch (err) {
      res.status(401).json({
        connected: false,
        appId: serverConfig.derivClientId,
        accounts: [],
        error: err instanceof Error ? err.message : 'Deriv OAuth session expired',
      });
    }
  });

  app.post('/api/v1/auth/deriv/connect-token', async (req: Request, res: Response) => {
    const parsed = z.object({ token: z.string().min(6).max(4096) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid Deriv token is required' });
      return;
    }
    const cleanToken = parsed.data.token.trim().replace(/^Bearer\s+/i, '');
    const clientId = serverConfig.derivClientId;
    try {
      const rawAccounts = await fetchDerivOptionsAccounts(cleanToken, clientId);
      if (rawAccounts.length === 0) {
        res.status(400).json({ error: 'No Options trading accounts found for this token' });
        return;
      }
      const accounts = await hydrateAccountsWithBalances(cleanToken, clientId, rawAccounts);
      const preferred =
        accounts.find((a) => a.isVirtual && a.currency === 'USD') ||
        accounts.find((a) => a.isVirtual) ||
        accounts[0];
      saveDerivOAuthSession(res, req, {
        accessToken: cleanToken,
        expiresAt: Date.now() + 28800 * 1000,
        clientId,
        activeAccountId: preferred.accountId,
      });

      res.json({
        connected: true,
        authMode: 'OAUTH2_V2',
        appId: clientId,
        activeLoginId: preferred.accountId,
        activeIsVirtual: preferred.isVirtual,
        activeCurrency: preferred.currency,
        activeBalance: preferred.balance,
        scopes: serverConfig.derivOAuthScopes.split(/\s+/),
        accounts: accounts.map((a) => ({
          loginid: a.accountId,
          currency: a.currency,
          isVirtual: a.isVirtual,
          balance: a.balance,
          hasToken: true,
          accountCategory: a.accountType,
        })),
      });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Deriv token verification failed',
      });
    }
  });

  app.post('/api/v1/auth/deriv/switch', async (req: Request, res: Response) => {
    const parsed = z.object({ accountId: z.string().min(2).max(64) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid accountId' });
      return;
    }
    const existing = readDerivOAuthSession(req);
    if (!existing) {
      res.status(401).json({ error: 'Not authenticated with Deriv OAuth' });
      return;
    }
    try {
      const sess = await refreshDerivOAuthIfNeeded(existing, res, req);
      const accounts = await hydrateAccountsWithBalances(
        sess.accessToken,
        sess.clientId,
        await fetchDerivOptionsAccounts(sess.accessToken, sess.clientId)
      );
      const target = accounts.find((a) => a.accountId === parsed.data.accountId);
      if (!target) {
        res.status(404).json({ error: `Account ${parsed.data.accountId} not found in Deriv profile` });
        return;
      }
      saveDerivOAuthSession(res, req, { ...sess, activeAccountId: target.accountId });
      res.json({
        connected: true,
        authMode: 'OAUTH2_V2',
        appId: sess.clientId,
        activeLoginId: target.accountId,
        activeIsVirtual: target.isVirtual,
        activeCurrency: target.currency,
        activeBalance: target.balance,
        scopes: serverConfig.derivOAuthScopes.split(/\s+/),
        accounts: accounts.map((a) => ({
          loginid: a.accountId,
          currency: a.currency,
          isVirtual: a.isVirtual,
          balance: a.balance,
          hasToken: true,
          accountCategory: a.accountType,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to switch Deriv account' });
    }
  });

  app.post('/api/v1/auth/deriv/logout', (req: Request, res: Response) => {
    clearAuthCookie(res, DERIV_OAUTH_SESSION_COOKIE, req);
    clearAuthCookie(res, DERIV_OAUTH_TX_COOKIE, req);
    res.json({ connected: false });
  });

  app.post('/api/v1/deriv/v2/otp', async (req: Request, res: Response) => {
    const existing = readDerivOAuthSession(req);
    if (!existing) {
      res.status(401).json({ error: 'Not authenticated with Deriv OAuth' });
      return;
    }
    const parsed = z.object({ accountId: z.string().min(2).max(64).optional() }).safeParse(req.body ?? {});
    const accountId = parsed.success && parsed.data.accountId ? parsed.data.accountId : existing.activeAccountId;
    if (!accountId) {
      res.status(400).json({ error: 'Missing Deriv accountId' });
      return;
    }
    try {
      const sess = await refreshDerivOAuthIfNeeded(existing, res, req);
      const otp = await createDerivOptionsOtp(sess.accessToken, sess.clientId, accountId);
      res.json({ ...otp, accountId, appId: sess.clientId });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to generate Deriv OTP' });
    }
  });

  app.post('/api/v1/deriv/v2/buy', async (req: Request, res: Response) => {
    const existing = readDerivOAuthSession(req);
    if (!existing) {
      res.status(401).json({ error: 'Not authenticated with Deriv OAuth' });
      return;
    }
    const schema = z.object({
      accountId: z.string().min(2).max(64),
      symbol: z.string().regex(SYMBOL_REGEX),
      contractType: z.string().min(2).max(32),
      amount: z.number().positive().max(1000),
      currency: z.string().min(3).max(8).default('USD'),
      duration: z.number().int().min(1).max(86400),
      durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).default('t'),
      barrier: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_DERIV_V2_BUY_REQUEST' });
      return;
    }
    try {
      const sess = await refreshDerivOAuthIfNeeded(existing, res, req);
      const otp = await createDerivOptionsOtp(sess.accessToken, sess.clientId, parsed.data.accountId);
      const buyResult = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(otp.url, { handshakeTimeout: 5000, perMessageDeflate: false });
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          reject(new Error('Deriv OTP trade timed out'));
        }, 12_000);

        ws.once('open', () => {
          const propReq: Record<string, unknown> = {
            proposal: 1,
            amount: parsed.data.amount,
            basis: 'stake',
            contract_type: parsed.data.contractType,
            currency: parsed.data.currency,
            duration: parsed.data.duration,
            duration_unit: parsed.data.durationUnit,
            underlying_symbol: parsed.data.symbol,
            req_id: 1,
          };
          if (parsed.data.barrier !== undefined && parsed.data.barrier !== '') {
            propReq.barrier = parsed.data.barrier;
          }
          ws.send(JSON.stringify(propReq));
        });

        ws.on('message', (raw) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          } catch {
            return;
          }
          const err = msg.error as { message?: string } | undefined;
          if (err?.message) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(new Error(err.message));
            return;
          }
          if (msg.req_id === 1 && msg.proposal) {
            const p = msg.proposal as { id: string; ask_price: number };
            ws.send(JSON.stringify({ buy: p.id, price: p.ask_price, req_id: 2 }));
            return;
          }
          if (msg.req_id === 2 && msg.buy) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve(msg.buy as Record<string, unknown>);
          }
        });

        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(new Error(err.message || 'Deriv OTP WebSocket failed'));
        });
      });

      res.json({ buy: buyResult, appId: sess.clientId });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Deriv trade placement failed' });
    }
  });

  app.post('/api/v1/deriv/v2/contract-status', async (req: Request, res: Response) => {
    const existing = readDerivOAuthSession(req);
    if (!existing) {
      res.status(401).json({ error: 'Not authenticated with Deriv OAuth' });
      return;
    }
    const parsed = z
      .object({
        accountId: z.string().min(2).max(64),
        contractId: z.number().int().positive(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_CONTRACT_STATUS_REQUEST' });
      return;
    }
    try {
      const sess = await refreshDerivOAuthIfNeeded(existing, res, req);
      const otp = await createDerivOptionsOtp(sess.accessToken, sess.clientId, parsed.data.accountId);
      const poc = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(otp.url, { handshakeTimeout: 4500, perMessageDeflate: false });
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          reject(new Error('Deriv contract status timed out'));
        }, 7000);
        ws.once('open', () => {
          ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: parsed.data.contractId, req_id: 1 }));
        });
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            const err = msg.error as { message?: string } | undefined;
            if (err?.message) {
              clearTimeout(timer);
              ws.close();
              reject(new Error(err.message));
              return;
            }
            if (msg.proposal_open_contract) {
              clearTimeout(timer);
              ws.close();
              resolve(msg.proposal_open_contract as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        });
        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(new Error(err.message || 'Deriv OTP WebSocket failed'));
        });
      });
      res.json({ proposal_open_contract: poc });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Unable to fetch contract status' });
    }
  });

  app.get('/api/v1/live/control', (_req: Request, res: Response) => {
    res.json({
      control: previewStore.liveGate,
      deployment_gate: serverConfig.liveTradingEnabled,
      max_stake_cap: serverConfig.liveMaxStake,
      max_daily_loss_cap: serverConfig.liveMaxDailyLoss,
      execution: 'MANUAL_APPROVAL_ONLY',
      intents: previewStore.liveIntents.slice(0, 25),
    });
  });

  app.post('/api/v1/live/kill-switch', (_req: Request, res: Response) => {
    previewStore.liveGate.live_enabled = false;
    previewStore.liveGate.automation_enabled = false;
    previewStore.liveGate.kill_switch = true;
    previewStore.liveGate.updated_at = new Date().toISOString();
    previewStore.automationControl.enabled = false;
    previewStore.automationControl.kill_switch = true;
    previewStore.automationControl.paused_reason = 'Emergency Kill Switch activated by operator';
    previewStore.automationControl.updated_at = new Date().toISOString();
    previewStore.alerts.unshift({
      alert_id: previewStore.nextAlertId++,
      severity: 'CRITICAL',
      alert_code: 'KILL_SWITCH_ACTIVATED',
      message: 'Emergency stop active: all live approvals and automated entries halted.',
      acknowledged_at: null,
      created_at: new Date().toISOString(),
    });
    res.json({
      liveGate: previewStore.liveGate,
      automationControl: previewStore.automationControl,
    });
  });

  app.post('/api/v1/live/reset-kill-switch', (_req: Request, res: Response) => {
    previewStore.liveGate.kill_switch = false;
    previewStore.liveGate.updated_at = new Date().toISOString();
    previewStore.automationControl.kill_switch = false;
    previewStore.automationControl.paused_reason = null;
    previewStore.automationControl.updated_at = new Date().toISOString();
    res.json({
      liveGate: previewStore.liveGate,
      automationControl: previewStore.automationControl,
    });
  });

  // ---------------- AI ANALYSER BOT BRIEF (GEMINI 4 HYDROGEN) ----------------

  app.post('/api/v1/ai/analyze-brief', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        symbol: z.string().regex(SYMBOL_REGEX),
        spotQuote: z.string().nullable().default(null),
        latestDigit: z.number().int().min(0).max(9).nullable().default(null),
        tickWindowCount: z.number().int().min(0).max(5000).default(0),
        volatilityRegime: z.string().default('INSUFFICIENT_DATA'),
        evenPct: z.number().min(0).max(100).default(50),
        oddPct: z.number().min(0).max(100).default(50),
        over4Pct: z.number().min(0).max(100).default(50),
        under5Pct: z.number().min(0).max(100).default(50),
        hottestDigit: z.object({ digit: z.number().int().min(0).max(9), pct: z.number() }).nullable().default(null),
        coldestDigit: z.object({ digit: z.number().int().min(0).max(9), pct: z.number() }).nullable().default(null),
        matchBreakEvenPct: z.number().nullable().default(null),
        differBreakEvenPct: z.number().nullable().default(null),
        quantDirection: z.string().nullable().default(null),
        quantConfidencePct: z.number().nullable().default(null),
        quantRegime: z.string().nullable().default(null),
        rsi14: z.number().nullable().default(null),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_AI_BRIEF_PAYLOAD' });
      return;
    }

    try {
      const brief = await generateAiMarketBrief(parsed.data);
      res.json(brief);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI analysis failed';
      const status = msg.includes('GEMINI_API_KEY') ? 503 : 502;
      res.status(status).json({ error: msg });
    }
  });

  // ---------------- STATELESS HTTPS -> DERIV WS FALLBACK BRIDGE ----------------
  // Used automatically when browser WebSocket connections are blocked by mobile carrier/ISP/DNS.
  app.post('/api/v1/deriv/proxy', async (req: Request, res: Response) => {
    const parsed = z
      .object({
        appId: z.string().regex(/^\d+$/).optional(),
        token: z.string().min(4).max(256).optional(),
        payload: z.record(z.string(), z.unknown()),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_DERIV_PROXY_REQUEST' });
      return;
    }

    const allowedKeys = [
      'active_symbols',
      'contracts_for',
      'ticks_history',
      'ticks',
      'proposal',
      'authorize',
      'balance',
      'portfolio',
      'proposal_open_contract',
      'buy',
      'sell',
      'ping',
    ];
    const p = { ...parsed.data.payload };
    delete p.subscribe; // one-shot HTTP bridge never opens subscriptions
    const hasAllowedKey = allowedKeys.some((k) => k in p);
    if (!hasAllowedKey) {
      res.status(403).json({ error: 'UNSUPPORTED_DERIV_PROXY_METHOD' });
      return;
    }

    const appId = parsed.data.appId || serverConfig.derivAppId || '1089';
    const hosts = Array.from(
      new Set([
        serverConfig.derivPublicWsUrl || 'wss://ws.derivws.com/websockets/v3',
        'wss://ws.derivws.com/websockets/v3',
        'wss://frontend.derivws.com/websockets/v3',
        'wss://ws.binaryws.com/websockets/v3',
      ])
    );

    const runOneShot = (wsUrl: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const sep = wsUrl.includes('?') ? '&' : '?';
        const fullUrl = wsUrl.includes('app_id=') ? wsUrl : `${wsUrl}${sep}app_id=${encodeURIComponent(appId)}`;
        const ws = new WebSocket(fullUrl, { handshakeTimeout: 5000, perMessageDeflate: false });
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          reject(new Error('Deriv proxy request timed out'));
        }, 9000);

        const cleanup = () => clearTimeout(timer);
        let stage: 'auth' | 'main' = parsed.data.token && !('authorize' in p) ? 'auth' : 'main';

        ws.once('open', () => {
          if (stage === 'auth') {
            ws.send(JSON.stringify({ authorize: parsed.data.token, req_id: 1 }));
          } else {
            ws.send(JSON.stringify({ ...p, req_id: 2 }));
          }
        });

        ws.on('message', (raw) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          } catch {
            return;
          }
          const err = msg.error as { message?: string } | undefined;
          if (err?.message) {
            cleanup();
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(new Error(err.message));
            return;
          }
          if (stage === 'auth' && msg.req_id === 1) {
            stage = 'main';
            ws.send(JSON.stringify({ ...p, req_id: 2 }));
            return;
          }
          if (msg.req_id === 2 || !('req_id' in msg)) {
            cleanup();
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve(msg);
          }
        });

        ws.once('error', (err) => {
          cleanup();
          reject(new Error(err.message || 'Deriv proxy WebSocket error'));
        });
      });

    let lastErr: Error | null = null;
    for (const h of hosts) {
      try {
        const result = await runOneShot(h);
        res.json(result);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Don't retry other hosts on logical Deriv API rejections (e.g. InvalidToken)
        if (!/timeout|closed|ECONN|ENOTFOUND|network|Unexpected server response|WebSocket/i.test(lastErr.message)) {
          res.status(400).json({ error: lastErr.message });
          return;
        }
      }
    }
    res.status(502).json({ error: lastErr?.message || 'Unable to reach Deriv servers' });
  });
}
