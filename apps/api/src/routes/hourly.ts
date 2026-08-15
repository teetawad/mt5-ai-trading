import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import {
  addWatchlistSymbol,
  listWatchlist,
  setWatchlistSymbolEnabled,
} from '../db/repositories/hourly-watchlist';
import {
  ensureHourlyStrategy,
  phase27RiskControls,
  runHourlyAnalysis,
} from '../services/hourly-decision-service';
import { riskConfig } from '../services/trade-proposal-service';
import { getMarketSnapshot, getPaperPortfolio, TradingEngineError } from '../services/trading-engine-client';
import Decimal from 'decimal.js';

export const hourlyRouter = Router();

hourlyRouter.use(requireAuth);

const SUPPORTED_US_STOCK_PATTERN = /^[A-Z]{1,5}(\.[A-Z])?$/;

function requestId(req: Request): string | undefined {
  return (req.headers['x-request-id'] as string | undefined) ?? undefined;
}

hourlyRouter.get('/watchlist', async (_req: Request, res: Response) => {
  res.json({ watchlist: await listWatchlist(getPool()) });
});

hourlyRouter.post('/watchlist', requireOwner, async (req: Request, res: Response) => {
  const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
  if (!SUPPORTED_US_STOCK_PATTERN.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'symbol must be a supported US stock symbol' });
    return;
  }
  const entry = await addWatchlistSymbol(getPool(), symbol, req.user!.sub);
  res.status(201).json({ entry });
});

hourlyRouter.patch('/watchlist/:id', requireOwner, async (req: Request, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'enabled must be a boolean' });
    return;
  }
  const entry = await setWatchlistSymbolEnabled(getPool(), req.params.id, enabled, req.user!.sub);
  if (!entry) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Watchlist entry not found' });
    return;
  }
  res.json({ entry });
});

hourlyRouter.get('/analysis/:symbol', async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol ?? '').trim().toUpperCase();
  if (!SUPPORTED_US_STOCK_PATTERN.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'symbol must be a supported US stock symbol' });
    return;
  }

  const pool = getPool();
  try {
    const paperPortfolio = await getPaperPortfolio(requestId(req));
    const hasOpenPosition = new Decimal(paperPortfolio.positions[symbol] ?? '0').gt(0);
    const { analysis, settings } = await runHourlyAnalysis(symbol, pool, hasOpenPosition, requestId(req));

    const [market, latestSnapshot, cfg, strategy] = await Promise.all([
      getMarketSnapshot(symbol, requestId(req)),
      findLatestSnapshot(pool),
      riskConfig(pool),
      ensureHourlyStrategy(pool),
    ]);
    if (!market) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }

    const requestedQuantity = analysis.decision === 'SELL'
      ? (paperPortfolio.positions[symbol] ?? '0')
      : settings.defaultQuantity;

    const sizingPreview = analysis.decision === 'HOLD'
      ? null
      : await phase27RiskControls(pool, {
        symbol,
        strategyId: strategy.id,
        side: analysis.decision,
        analysis,
        market,
        paperPortfolio,
        latestSnapshot,
        riskCfg: cfg,
        settings,
        requestedQuantity,
      });

    res.json({ analysis, settings, sizingPreview, hasOpenPosition });
  } catch (err) {
    if (err instanceof TradingEngineError && err.status === 404) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    throw err;
  }
});
