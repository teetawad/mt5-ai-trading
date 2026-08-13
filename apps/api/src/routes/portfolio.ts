import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { listSnapshots } from '../db/repositories/portfolio-snapshots';
import { getSettingValue } from '../db/repositories/system-settings';
import { ensureDayStartSnapshot, getDayStartEquity, getLivePortfolioView } from '../services/trade-execution-service';

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

function requestId(req: Request): string | undefined {
  return req.headers['x-request-id'] as string | undefined;
}

async function currentDailyPnl(pool: ReturnType<typeof getPool>, portfolioEquity: string): Promise<string> {
  const initialCashSetting = await getSettingValue(pool, 'initial_paper_cash_usd');
  const dayStartEquity = await getDayStartEquity(pool, new Date(), String(initialCashSetting ?? '100000'));
  return new Decimal(portfolioEquity).minus(dayStartEquity).toDecimalPlaces(8).toFixed(8);
}

/**
 * Current portfolio figures, computed live from getLivePortfolioView — the
 * same authoritative source GET /positions and GET /dashboard/paper read
 * from, so the three can never disagree. Persisted portfolio_snapshots rows
 * are historical only (see /snapshots below and getDayStartEquity's baseline
 * lookup); they must never drive these "current" figures.
 */
portfolioRouter.get('/', async (req: Request, res: Response) => {
  const pool = getPool();
  const view = await getLivePortfolioView(pool, requestId(req));
  await ensureDayStartSnapshot(pool, view);
  const dailyPnl = await currentDailyPnl(pool, view.portfolioEquity);

  res.json({
    source: 'INTERNAL_LEDGER',
    cashBalance: view.cashBalance,
    portfolioEquity: view.portfolioEquity,
    realizedPnl: view.realizedPnl,
    unrealizedPnl: view.unrealizedPnl,
    dailyPnl,
    openPositions: view.positions,
    pendingOrders: [],
    lastUpdatedAt: view.asOf,
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

portfolioRouter.get('/pnl', async (req: Request, res: Response) => {
  const pool = getPool();
  const view = await getLivePortfolioView(pool, requestId(req));
  await ensureDayStartSnapshot(pool, view);
  const dailyPnl = await currentDailyPnl(pool, view.portfolioEquity);
  res.json({
    realizedPnl: view.realizedPnl,
    unrealizedPnl: view.unrealizedPnl,
    dailyPnl,
  });
});
