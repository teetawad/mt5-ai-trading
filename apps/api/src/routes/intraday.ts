import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import {
  ensureIntradayStrategy,
  phase25RiskControls,
  runIntradayAnalysis,
} from '../services/intraday-decision-service';
import { riskConfig } from '../services/trade-proposal-service';
import { reconcileIntradayTimeExits } from '../services/trade-execution-service';
import { getMarketSnapshot, getPaperPortfolio, TradingEngineError } from '../services/trading-engine-client';

export const intradayRouter = Router();

intradayRouter.use(requireAuth);

const SUPPORTED_US_STOCK_PATTERN = /^[A-Z]{1,5}(\.[A-Z])?$/;

function requestId(req: Request): string | undefined {
  return (req.headers['x-request-id'] as string | undefined) ?? undefined;
}

intradayRouter.get('/analysis/:symbol', async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol ?? '').trim().toUpperCase();
  if (!SUPPORTED_US_STOCK_PATTERN.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'symbol must be a supported US stock symbol' });
    return;
  }

  const pool = getPool();
  try {
    const { analysis, settings } = await runIntradayAnalysis(symbol, pool, requestId(req));

    const [market, paperPortfolio, latestSnapshot, cfg, strategy] = await Promise.all([
      getMarketSnapshot(symbol, requestId(req)),
      getPaperPortfolio(requestId(req)),
      findLatestSnapshot(pool),
      riskConfig(pool),
      ensureIntradayStrategy(pool),
    ]);
    if (!market) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Symbol not found: ${symbol}` });
      return;
    }

    const sizingPreview = await phase25RiskControls(pool, {
      symbol,
      strategyId: strategy.id,
      analysis,
      market,
      paperPortfolio,
      latestSnapshot,
      riskCfg: cfg,
      settings,
      requestedQuantity: settings.defaultQuantity,
    });

    res.json({ analysis, settings, sizingPreview });
  } catch (err) {
    if (err instanceof TradingEngineError && err.status === 404) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    throw err;
  }
});

intradayRouter.post('/reconcile-time-exits', requireOwner, async (req: Request, res: Response) => {
  const result = await reconcileIntradayTimeExits(getPool(), {
    actorId: req.user!.sub,
    actorEmail: req.user!.email,
    requestId: requestId(req),
  }, requestId(req));
  res.json(result);
});
