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
import { executeEntryPlanById, getEntryPlanWatcherStatus, listActiveEntryPlans, sendMt5DemoTestOrder } from '../services/mt5-entry-plan-watcher';
import { getMt5Status, listMt5PendingOrders } from '../services/mt5-client';
import { loadMt5RiskSettings, mt5RiskSettingsRows } from '../config/mt5-risk-settings';
import { aiScannerSettingsRows, loadAiScannerSettings } from '../config/ai-scanner-settings';
import { describeTradingAIProvider } from '../services/trading-ai/provider';
import { analyzeSymbolWithAI, approveAndPlaceAiTradePlan, cancelAiTradePlanOrder } from '../services/trading-ai/trading-ai-service';
import { getTopOpportunities, listScanCandidates, runOpportunityScan } from '../services/trading-ai/opportunity-scan';
import { getTradeScoreEvaluation } from '../services/trading-ai/score-evaluation';
import { getAiActionStats } from '../services/trading-ai/action-stats';
import {
  AiPlanValidationError,
  AiProviderAuthError,
  AiProviderBillingError,
  AiProviderNotConfiguredError,
  AiRequestTimeoutError,
  AiResponseInvalidError,
  AiUnknownSymbolError,
} from '../services/trading-ai/types';

// Every AI-layer error class carries a pre-written, non-technical message
// (never a raw stack trace or provider-internal detail) — safe to hand
// straight to the client. Order matters only in that each class is checked
// independently via instanceof, so ordering here is not significant.
function aiErrorResponse(res: Response, err: unknown): void {
  if (err instanceof AiUnknownSymbolError) {
    // A clear, immediate, application-level rejection — never a confusing
    // deep MT5-level "SYMBOL_NOT_FOUND" for a pseudo-symbol like SCAN/ALL/
    // BEST/* that should never have reached this endpoint at all.
    res.status(404).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiProviderNotConfiguredError) {
    res.status(503).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiPlanValidationError) {
    res.status(422).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiResponseInvalidError) {
    res.status(502).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiProviderAuthError) {
    res.status(502).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiProviderBillingError) {
    res.status(502).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof AiRequestTimeoutError) {
    res.status(504).json({ error: err.code, message: err.message });
    return;
  }
  mt5Error(res, err);
}

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

// Structured, non-throwing execution outcomes (`{executed, allowed, code,
// reason, ...}`) are the normal response for a blocked trade — a block is
// not an HTTP error, it's a well-formed answer with the exact rejected rule.
// The catch here only fires for genuinely unexpected failures (bad symbol,
// DB error, etc.), which is why it still gets its own error code so the
// frontend never has to fall back to a generic message either way.
//
// `success`/`mt5Confirmed` are always identical to `executed` by
// construction: executeClaimedPlan only ever returns executed:true after
// positions_get() has already confirmed a real MT5 position (see
// mt5-entry-plan-watcher.ts) - there is no code path that sets executed:true
// from a DB insert alone. The frontend must treat mt5Confirmed as the single
// source of truth for "did this actually open a position in MT5", never a
// 2xx HTTP status by itself.
export function buildExecutionOutcomeBody(outcomeValue: unknown): Record<string, unknown> {
  const outcome = outcomeValue as Record<string, unknown>;
  const executed = outcome.executed === true;
  const entryPlan = (outcome.entryPlan ?? null) as Record<string, unknown> | null;
  const body: Record<string, unknown> = {
    ...outcome,
    allowed: executed,
    code: (outcome.code as string | null | undefined) ?? null,
    message: (outcome.reason as string | undefined) ?? null,
    success: executed,
    mt5Confirmed: executed,
    symbol: entryPlan?.symbol ?? null,
    side: entryPlan?.side ?? null,
  };
  if (executed) {
    body.ticket = entryPlan?.order_ticket ?? null;
    body.orderTicket = entryPlan?.order_ticket ?? null;
    body.dealTicket = entryPlan?.deal_ticket ?? null;
    body.volume = entryPlan?.final_volume ?? null;
    body.actualEntry = entryPlan?.actual_entry ?? null;
    body.stopLoss = entryPlan?.stop_loss ?? null;
    body.takeProfit = entryPlan?.take_profit ?? null;
    body.openedAt = entryPlan?.opened_at ?? null;
  } else {
    body.details = { entryPlan, risk: outcome.risk ?? null, check: outcome.check ?? null, result: outcome.result ?? null };
    // A duplicate/second request landing after the plan already executed is
    // not a failure the owner needs to act on — hand back the real MT5
    // ticket from the earlier successful execution so the frontend can
    // offer "View Open Trade" instead of a scary red error for a trade that
    // is, in fact, open.
    if (outcome.code === 'ALREADY_EXECUTED' && entryPlan) {
      body.ticket = entryPlan.order_ticket ?? null;
      body.orderTicket = entryPlan.order_ticket ?? null;
      body.dealTicket = entryPlan.deal_ticket ?? null;
      body.volume = entryPlan.final_volume ?? null;
      body.actualEntry = entryPlan.actual_entry ?? null;
      body.stopLoss = entryPlan.stop_loss ?? null;
      body.takeProfit = entryPlan.take_profit ?? null;
    }
  }
  return body;
}

function executionOutcomeResponse(res: Response, outcomeValue: unknown) {
  const body = buildExecutionOutcomeBody(outcomeValue);
  res.status(body.executed === true ? 201 : 200).json(body);
}

mt5Router.post('/assisted-demo/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    executionOutcomeResponse(res, await executeAssistedDemo(getPool(), req.params.symbol, actor(req)));
  } catch (err) {
    res.status(422).json({
      executed: false, allowed: false, success: false, mt5Confirmed: false,
      code: 'UNEXPECTED_ERROR', message: (err as Error).message, error: (err as Error).message,
    });
  }
});

mt5Router.post('/auto-demo/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    executionOutcomeResponse(res, await executeAutoDemo(getPool(), req.params.symbol, actor(req)));
  } catch (err) {
    res.status(422).json({
      executed: false, allowed: false, success: false, mt5Confirmed: false,
      code: 'UNEXPECTED_ERROR', message: (err as Error).message, error: (err as Error).message,
    });
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
    executionOutcomeResponse(res, await executeEntryPlanById(getPool(), req.params.id, actor(req)));
  } catch (err) {
    res.status(422).json({
      executed: false, allowed: false, success: false, mt5Confirmed: false,
      code: 'UNEXPECTED_ERROR', message: (err as Error).message, error: (err as Error).message,
    });
  }
});

// Developer/diagnostic action only: verifies the execution pipe end to end
// (DEMO verification -> order_check -> order_send -> positions_get()
// confirmation) through the exact same DemoExecutionGateway as every other
// order path, independent of AI strategy/entry plans/AUTO-DEMO.
mt5Router.post('/demo-test-order', requireOwner, async (req: Request, res: Response) => {
  try {
    const symbol = typeof req.body?.symbol === 'string' ? req.body.symbol.trim().toUpperCase() : '';
    const side = req.body?.side === 'SELL' ? 'SELL' : 'BUY';
    if (!symbol) {
      res.status(422).json({ error: 'symbol is required' });
      return;
    }
    res.status(201).json(await sendMt5DemoTestOrder(getPool(), symbol, side, actor(req)));
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

// ---------------------------------------------------------------------------
// V3 Trading-Specialist AI: MT5 market/chart data -> AI plan -> Risk Engine
// -> owner approval -> real MT5 market/pending order -> reconciliation.
// ---------------------------------------------------------------------------

// Diagnostics-safe: provider name and model are not secrets, but the API
// key itself (OPENAI_API_KEY/ANTHROPIC_API_KEY) is NEVER included here or
// in any other response body/log line.
mt5Router.get('/ai-trade/status', requireOwner, async (_req: Request, res: Response) => {
  res.json(describeTradingAIProvider());
});

mt5Router.get('/ai-trade/plans', requireOwner, async (_req: Request, res: Response) => {
  try {
    const result = await getPool().query(
      `SELECT * FROM ai_trade_plans
       WHERE status IN ('WAITING_FOR_APPROVAL','PENDING_ORDER_SUBMITTING','PENDING_ORDER_PLACED','POSITION_OPEN')
       ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({ plans: result.rows });
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/ai-trade/pending-orders', requireOwner, async (req: Request, res: Response) => {
  try {
    const [orders, plans] = await Promise.all([
      listMt5PendingOrders(req.header('X-Request-ID') ?? undefined),
      getPool().query(`SELECT * FROM ai_trade_plans WHERE status='PENDING_ORDER_PLACED'`),
    ]);
    const byTicket = new Map(plans.rows.map((row) => [String(row.mt5_order_ticket), row]));
    res.json({ orders: orders.map((order) => ({ ...order, ai_trade_plan: byTicket.get(String(order.ticket)) ?? null })) });
  } catch (err) {
    mt5Error(res, err);
  }
});

// "FIND BEST TRADES": cheap deterministic filters over the watchlist, then
// the Trading AI only on the survivors, ranked by Trade Score (never by raw
// AI confidence). Owner-triggered only — never run automatically on a timer.
mt5Router.get('/ai-trade/candidates', requireOwner, async (req: Request, res: Response) => {
  try {
    res.json({ candidates: await listScanCandidates(getPool(), actor(req)) });
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/ai-trade/scan', requireOwner, async (req: Request, res: Response) => {
  try {
    res.status(201).json(await runOpportunityScan(getPool(), actor(req)));
  } catch (err) {
    mt5Error(res, err);
  }
});

// Home page "AI TOP OPPORTUNITIES": passive read of the most recent
// persisted analysis per watchlist symbol — never triggers a new AI call.
mt5Router.get('/ai-trade/top-opportunities', requireOwner, async (_req: Request, res: Response) => {
  try {
    res.json({ opportunities: await getTopOpportunities(getPool()) });
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.get('/ai-trade/score-evaluation', requireOwner, async (_req: Request, res: Response) => {
  try {
    res.json(await getTradeScoreEvaluation(getPool()));
  } catch (err) {
    mt5Error(res, err);
  }
});

// Decision-policy transparency: the configurable thresholds currently in
// effect (env-managed, same pattern as /risk-settings — never editable via
// this API) plus measured effect on trade frequency/quality (spec: "Add
// statistics to measure"). The old confidence/score threshold settings were
// removed with the "ALL VALID SETUPS ARE DEMO-ACTIONABLE" refactor —
// decision-policy.ts is now a purely mechanical mapping with nothing to
// configure; only the scanner's cost-control settings remain here.
mt5Router.get('/ai-trade/policy-settings', requireOwner, async (_req: Request, res: Response) => {
  res.json([...aiScannerSettingsRows(loadAiScannerSettings())]);
});

mt5Router.get('/ai-trade/action-stats', requireOwner, async (_req: Request, res: Response) => {
  try {
    res.json(await getAiActionStats(getPool()));
  } catch (err) {
    mt5Error(res, err);
  }
});

mt5Router.post('/ai-trade/plans/:id/approve', requireOwner, async (req: Request, res: Response) => {
  try {
    const outcome = await approveAndPlaceAiTradePlan(getPool(), req.params.id, actor(req));
    res.status(outcome.allowed ? 201 : 200).json(outcome);
  } catch (err) {
    res.status(422).json({ allowed: false, code: 'UNEXPECTED_ERROR', message: (err as Error).message });
  }
});

mt5Router.post('/ai-trade/plans/:id/cancel', requireOwner, async (req: Request, res: Response) => {
  try {
    const outcome = await cancelAiTradePlanOrder(getPool(), req.params.id, actor(req));
    res.status(outcome.allowed ? 200 : 409).json(outcome);
  } catch (err) {
    res.status(422).json({ allowed: false, code: 'UNEXPECTED_ERROR', message: (err as Error).message });
  }
});

// Single-symbol AI analysis. Registered LAST among every /ai-trade/* POST
// route on purpose: Express matches routes in registration order, and
// `:symbol` matches ANY single path segment. Registering this before a
// literal route like POST /ai-trade/scan meant every "FIND BEST TRADES"
// click was silently routed here with symbol="SCAN" instead of ever
// reaching runOpportunityScan — the actual root cause of the
// '"SCAN" is not a real MT5 instrument' bug (analyzeSymbolWithAI's own
// catalog guard, assetClassFor(), was working correctly the whole time; it
// was simply being handed the wrong request). A pseudo-symbol still can't
// slip through even if a future route gets registered after this one by
// mistake, since assetClassFor() independently rejects SCAN/ALL/BEST/*
// before ever touching MT5 — but correct ordering is what makes "FIND BEST
// TRADES" reach the real scanner at all.
mt5Router.post('/ai-trade/:symbol', requireOwner, async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.trim().toUpperCase();
    const result = await analyzeSymbolWithAI(getPool(), symbol, actor(req));
    if ('aiConfigured' in result && result.aiConfigured === false) {
      res.status(503).json({ error: 'AI_PROVIDER_NOT_CONFIGURED', message: result.message });
      return;
    }
    res.status(201).json(result);
  } catch (err) {
    aiErrorResponse(res, err);
  }
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
