import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import {
  findLatestSnapshot,
  listSnapshots,
} from '../db/repositories/portfolio-snapshots';
import { findOpenPositions } from '../db/repositories/positions';
import { getSettingValue } from '../db/repositories/system-settings';
import { calculatePortfolioPnl } from '../services/trade-execution-service';
import { getPaperPortfolio } from '../services/trading-engine-client';

export const portfolioRouter = Router();

portfolioRouter.use(requireAuth);

function pagination(req: Request): { limit: number; offset: number } | null {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (
    !Number.isInteger(limit)
    || !Number.isInteger(offset)
    || limit < 1
    || limit > 100
    || offset < 0
  ) {
    return null;
  }
  return { limit, offset };
}

portfolioRouter.get('/', async (_req: Request, res: Response) => {
  const pool = getPool();
  const latest = await findLatestSnapshot(pool);
  const positions = await findOpenPositions(pool);

  if (latest) {
    res.json({
      source: 'INTERNAL_LEDGER',
      cashBalance: latest.cashBalance,
      portfolioEquity: latest.portfolioEquity,
      realizedPnl: latest.realizedPnl,
      unrealizedPnl: latest.unrealizedPnl,
      dailyPnl: latest.dailyPnl,
      openPositions: positions,
      pendingOrders: latest.pendingOrders,
      lastUpdatedAt: latest.createdAt,
    });
    return;
  }

  const [paperPortfolio, initialCash] = await Promise.all([
    getPaperPortfolio(),
    getSettingValue(pool, 'initial_paper_cash_usd'),
  ]);
  const pnl = calculatePortfolioPnl(String(initialCash ?? '100000'), paperPortfolio.cash, positions);

  res.json({
    source: 'INTERNAL_LEDGER',
    cashBalance: paperPortfolio.cash,
    portfolioEquity: pnl.portfolioEquity,
    realizedPnl: pnl.realizedPnl,
    unrealizedPnl: pnl.unrealizedPnl,
    dailyPnl: pnl.realizedPnl,
    openPositions: positions,
    pendingOrders: [],
    lastUpdatedAt: null,
  });
});

portfolioRouter.get('/snapshots', async (req: Request, res: Response) => {
  const page = pagination(req);
  if (!page) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }
  res.json({ snapshots: await listSnapshots(getPool(), page.limit, page.offset), ...page });
});

portfolioRouter.get('/pnl', async (_req: Request, res: Response) => {
  const latest = await findLatestSnapshot(getPool());
  res.json({
    realizedPnl: latest?.realizedPnl ?? '0.00000000',
    unrealizedPnl: latest?.unrealizedPnl ?? '0.00000000',
    dailyPnl: latest?.dailyPnl ?? '0.00000000',
  });
});
