import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findPositionBySymbol } from '../db/repositories/positions';
import { getLivePortfolioView, liveMarketData, mergeLivePosition } from '../services/trade-execution-service';

export const positionsRouter = Router();

positionsRouter.use(requireAuth);

function requestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

positionsRouter.get('/', async (req: Request, res: Response) => {
  const view = await getLivePortfolioView(getPool(), requestId(req));
  res.json({
    positions: view.positions,
    marketDataStatus: view.marketDataStatus,
    asOf: view.asOf,
  });
});

positionsRouter.get('/:symbol', async (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!/^[A-Z0-9.]{1,10}$/.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }

  const position = await findPositionBySymbol(getPool(), symbol);
  if (!position) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Position not found' });
    return;
  }
  if (Number(position.quantity) === 0) {
    res.json({ ...position, isStale: false, priceAsOf: null, marketValue: '0.00000000' });
    return;
  }
  const market = await liveMarketData(requestId(req));
  res.json(mergeLivePosition(position, market));
});
