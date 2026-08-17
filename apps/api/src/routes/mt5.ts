import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';
import { requireAuth, requireOwner } from '../auth/middleware';
import { setSetting } from '../db/repositories/system-settings';
import {
  executeAssistedDemo,
  executeAutoDemo,
  getMt5AnalysisDetail,
  getMt5Dashboard,
  getMt5MarketHours,
  getMt5OpenPositions,
  listMt5TradeHistory,
  listMt5Instruments,
  scannerSnapshot,
  setMt5WatchlistSymbols,
  syncMt5Instruments,
} from '../services/mt5-demo-lab-service';
import { executeEntryPlanById, getEntryPlanWatcherStatus, listActiveEntryPlans } from '../services/mt5-entry-plan-watcher';
import { getMt5Status } from '../services/mt5-client';
import { loadMt5RiskSettings, mt5RiskSettingsRows } from '../config/mt5-risk-settings';

export const mt5Router = Router();

mt5Router.use(requireAuth);

function actor(req: Request) {
  const actorId = req.user?.sub && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.user.sub)
    ? req.user.sub
    : null;
  return {
    actorId,
    actorEmail: req.user?.email ?? 'system@internal',
    requestId: req.header('X-Request-ID') ?? null,
  };
}

function mt5Error(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : 'MT5 request failed';
  const status = typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : 503;
  res.status(status >= 400 && status < 600 ? status : 503).json({
    error: 'MT5_BACKEND_ERROR',
    message,
  });
}

mt5Router.get('/status', async (req: Request, res: Response) => {
  try {
    res.json(await getMt5Status(req.header('X-Request-ID') ?? undefined));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/sync-instruments', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await syncMt5Instruments(getPool(), req.header('X-Request-ID') ?? undefined));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/instruments', requireOwner, async (req: Request, res: Response) => {
  try {
    const enabledParam = String(req.query.enabled ?? 'all');
    const enabled = enabledParam === 'enabled' ? true : enabledParam === 'disabled' ? false : undefined;
    res.json(await listMt5Instruments(getPool(), {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      assetClass: typeof req.query.assetClass === 'string' ? req.query.assetClass : undefined,
      enabled,
    }));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.patch('/watchlist', requireOwner, async (req: Request, res: Response) => {
  try {
    if (!Array.isArray(req.body?.symbols) || typeof req.body?.enabled !== 'boolean') {
      res.status(422).json({ error: 'INVALID_WATCHLIST_UPDATE', message: 'symbols[] and enabled are required' });
      return;
    }
    res.json(await setMt5WatchlistSymbols(getPool(), req.body.symbols, req.body.enabled, actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/scanner', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await scannerSnapshot(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/dashboard', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await getMt5Dashboard(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/market-hours', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await getMt5MarketHours(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/scanner/run', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await scannerSnapshot(getPool(), actor(req), true));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/analysis/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await getMt5AnalysisDetail(getPool(), req.params.symbol, actor(req), true));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/analysis/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await getMt5AnalysisDetail(getPool(), req.params.symbol, actor(req), false));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/assisted-demo/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await executeAssistedDemo(getPool(), req.params.symbol, actor(req)));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

mt5Router.post('/auto-demo/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await executeAutoDemo(getPool(), req.params.symbol, actor(req)));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

mt5Router.get('/positions', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await getMt5OpenPositions(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/history', requireOwner, async (_req: Request, res: Response) => {
  try {
    res.json(await listMt5TradeHistory(getPool()));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/entry-plans', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json(await listActiveEntryPlans(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/entry-watcher/status', requireOwner, async (_req: Request, res: Response) => {
  res.json(getEntryPlanWatcherStatus());
});

mt5Router.post('/entry-plans/:id/execute', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await executeEntryPlanById(getPool(), req.params.id, actor(req)));
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});

mt5Router.get('/auto-demo', requireOwner, async (_req: Request, res: Response) => {
  res.json({ enabled: loadMt5RiskSettings().mt5_auto_demo_enabled });
});

mt5Router.put('/auto-demo', requireOwner, async (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(422).json({ error: 'enabled must be boolean' });
    return;
  }
  const active = loadMt5RiskSettings().mt5_auto_demo_enabled;
  if (req.body.enabled !== active) {
    res.status(409).json({
      error: 'MT5_ENV_MANAGED_SETTING',
      message: 'MT5_AUTO_DEMO_ENABLED is controlled by the root .env configuration.',
      enabled: active,
    });
    return;
  }
  const updated = await setSetting(getPool(), 'mt5_auto_demo_enabled', active, req.user!.sub);
  res.json({ enabled: updated.value === true });
});

mt5Router.get('/risk-settings', requireOwner, async (_req: Request, res: Response) => {
  res.json(mt5RiskSettingsRows().filter((row) => row.key !== 'mt5_entry_plan_valid_hours'));
});

mt5Router.put('/risk-preset', requireOwner, async (_req: Request, res: Response) => {
  res.status(409).json({
    error: 'MT5_ENV_MANAGED_SETTING',
    message: 'MT5 risk settings are controlled by the root .env configuration.',
    settings: mt5RiskSettingsRows(loadMt5RiskSettings()),
  });
});
