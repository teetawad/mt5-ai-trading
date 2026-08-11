import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import {
  getMarketSnapshot,
  getAllMarketSnapshots,
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
    res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Market data service is unavailable',
    });
    return;
  }
  throw err;
}

// GET /market-data/snapshot/:symbol
marketDataRouter.get('/snapshot/:symbol', async (req: Request, res: Response) => {
  const { symbol } = req.params;
  if (!symbol || !/^[A-Z0-9.]{1,10}$/i.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }

  try {
    const snapshot = await getMarketSnapshot(symbol.toUpperCase(), requestId(req));
    if (!snapshot) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }
    res.json({
      symbol: snapshot.symbol,
      price: snapshot.price,
      bid: snapshot.bid,
      ask: snapshot.ask,
      volume: snapshot.volume,
      timestamp: snapshot.timestamp,
      isStale: snapshot.is_stale,
    });
  } catch (err) {
    handleEngineError(err, res);
  }
});

// GET /market-data/snapshots
marketDataRouter.get('/snapshots', async (req: Request, res: Response) => {
  try {
    const snapshots = await getAllMarketSnapshots(requestId(req));
    res.json(
      snapshots.map((s) => ({
        symbol: s.symbol,
        price: s.price,
        bid: s.bid,
        ask: s.ask,
        volume: s.volume,
        timestamp: s.timestamp,
        isStale: s.is_stale,
      })),
    );
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
