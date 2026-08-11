import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import {
  getMarketSnapshot,
  getAllMarketSnapshots,
  getHistoricalBars,
  getLatestQuote,
  getLatestTrade,
  getTrackedSymbols,
  TradingEngineError,
} from '../services/trading-engine-client';

export const marketDataRouter = Router();

marketDataRouter.use(requireAuth);

function requestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

function handleEngineError(err: unknown, res: Response): void {
  if (err instanceof TradingEngineError) {
    if (err.status === 429) {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Market data rate limit exceeded',
      });
      return;
    }
    if (err.status === 501) {
      res.status(501).json({
        error: 'NOT_SUPPORTED',
        message: 'Market data provider does not support this operation',
      });
      return;
    }
    res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Market data service is unavailable',
    });
    return;
  }
  throw err;
}

function validSymbol(symbol: string): boolean {
  return /^[A-Z0-9.]{1,10}$/i.test(symbol);
}

function mapSnapshot(snapshot: Awaited<ReturnType<typeof getMarketSnapshot>>) {
  if (!snapshot) return null;
  return {
    symbol: snapshot.symbol,
    price: snapshot.price,
    bid: snapshot.bid,
    ask: snapshot.ask,
    volume: snapshot.volume,
    timestamp: snapshot.timestamp,
    isStale: snapshot.is_stale,
  };
}

// GET /market-data/snapshot/:symbol
marketDataRouter.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  if (!symbol || !validSymbol(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }

  try {
    const snapshot = await getMarketSnapshot(symbol.toUpperCase(), requestId(req));
    if (!snapshot) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }
    res.json(mapSnapshot(snapshot));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/snapshots
marketDataRouter.get('/snapshots', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllMarketSnapshots(requestId(req));
    res.json(snapshots.map((s) => mapSnapshot(s)));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/symbols
marketDataRouter.get('/symbols', async (req: Request, res: Response) => {
  try {
    const symbols = await getTrackedSymbols(requestId(req));
    res.json(symbols);
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/bars/:symbol
marketDataRouter.get('/bars/:symbol', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  if (!symbol || !validSymbol(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }
  const timeframe = typeof req.query.timeframe === 'string' ? req.query.timeframe : null;
  const start = typeof req.query.start === 'string' ? req.query.start : null;
  const end = typeof req.query.end === 'string' ? req.query.end : undefined;
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!timeframe || !start || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid bars query' });
    return;
  }

  try {
    const bars = await getHistoricalBars(
      symbol.toUpperCase(),
      { timeframe, start, end, limit },
      requestId(req),
    );
    res.json(bars.map((bar) => ({
      symbol: bar.symbol,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      timestamp: bar.timestamp,
      tradeCount: bar.trade_count ?? null,
      vwap: bar.vwap ?? null,
    })));
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/quote/:symbol
marketDataRouter.get('/quote/:symbol', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  if (!symbol || !validSymbol(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }
  try {
    const quote = await getLatestQuote(symbol.toUpperCase(), requestId(req));
    if (!quote) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }
    res.json({
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      bidSize: quote.bid_size,
      askSize: quote.ask_size,
      timestamp: quote.timestamp,
      isStale: quote.is_stale,
    });
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/trade/:symbol
marketDataRouter.get('/trade/:symbol', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  if (!symbol || !validSymbol(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }
  try {
    const trade = await getLatestTrade(symbol.toUpperCase(), requestId(req));
    if (!trade) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }
    res.json({
      symbol: trade.symbol,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      exchange: trade.exchange ?? null,
      tradeId: trade.trade_id ?? null,
      isStale: trade.is_stale,
    });
  } catch (err) {
    handleEngineError(err, res);
  }
});
