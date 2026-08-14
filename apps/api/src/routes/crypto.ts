import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { SUPPORTED_CRYPTO_PATTERN } from '../services/asset-class';
import {
  ensureCryptoStrategy,
  loadPhase26Settings,
  phase26RiskControls,
  runCryptoAnalysis,
} from '../services/crypto-decision-service';
import { riskConfig } from '../services/trade-proposal-service';
import { getMarketSnapshot, getPaperPortfolio, TradingEngineError } from '../services/trading-engine-client';

export const cryptoRouter = Router();

cryptoRouter.use(requireAuth);

function requestId(req: Request): string | undefined {
  return (req.headers['x-request-id'] as string | undefined) ?? undefined;
}

cryptoRouter.get('/symbols', async (_req: Request, res: Response) => {
  const settings = await loadPhase26Settings(getPool());
  res.json({ symbols: settings.supportedSymbols, enabled: settings.cryptoTradingEnabled });
});

cryptoRouter.get('/analysis/:symbol', async (req: Request, res: Response) => {
  const symbol = String(req.params.symbol ?? '').trim().toUpperCase();
  if (!SUPPORTED_CRYPTO_PATTERN.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'symbol must be a supported crypto symbol' });
    return;
  }

  const pool = getPool();
  try {
    const paperPortfolio = await getPaperPortfolio(requestId(req));
    const hasOpenPosition = new Decimal(paperPortfolio.positions[symbol] ?? '0').gt(0);
    const { analysis, settings } = await runCryptoAnalysis(symbol, pool, hasOpenPosition, requestId(req));

    const [market, latestSnapshot, cfg, strategy] = await Promise.all([
      getMarketSnapshot(symbol, requestId(req)),
      findLatestSnapshot(pool),
      riskConfig(pool, 'CRYPTO'),
      ensureCryptoStrategy(pool),
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
      : await phase26RiskControls(pool, {
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
