import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(),
  getMt5Tick: vi.fn(),
  getMt5MarketStatus: vi.fn(),
  getMt5SymbolInfo: vi.fn(),
  listMt5Positions: vi.fn(),
  listMt5PendingOrders: vi.fn(),
  checkMt5Order: vi.fn(),
  sendMt5Order: vi.fn(),
  checkMt5PendingOrder: vi.fn(),
  sendMt5PendingOrder: vi.fn(),
  cancelMt5PendingOrder: vi.fn(),
  getMt5Bars: vi.fn(),
  getMt5Chart: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import { planComment } from '../services/trading-ai/trading-ai-service';
import { expireUnapprovedPlans, reconcilePendingOrders, reconcileStuckSubmissions, runAiTradePlanWatcherTick } from '../services/trading-ai/ai-trade-plan-watcher';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

async function insertPlan(pool: Pool, overrides: Partial<Record<string, unknown>> = {}) {
  const runRow = await pool.query(
    `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, opportunity_score)
     VALUES($1,'CRYPTO_CFD','anthropic','claude-sonnet-5','TRADING_AI_V3_PROMPT_001','{}'::jsonb,'BUY',70,75)
     RETURNING id`,
    [overrides.symbol ?? 'TESTWETH'],
  );
  const defaults: Record<string, unknown> = {
    analysis_run_id: runRow.rows[0].id,
    symbol: 'TESTWETH',
    asset_class: 'CRYPTO_CFD',
    ai_provider: 'anthropic',
    ai_model: 'claude-sonnet-5',
    ai_prompt_version: 'TRADING_AI_V3_PROMPT_001',
    decision: 'BUY',
    confidence_pct: 70,
    opportunity_score: 75,
    entry_type: 'PULLBACK',
    pending_order_type: 'BUY_LIMIT',
    entry_price: 1880,
    stop_loss: 1860,
    take_profit: 1920,
    risk_reward: 2,
    recommended_volume: 0.1,
    plan_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    reason_summary: 'test plan',
    risk_result: 'PASS',
    status: 'PENDING_ORDER_PLACED',
    mt5_order_ticket: '444555',
    placed_at: new Date().toISOString(),
    ...overrides,
  };
  const keys = Object.keys(defaults);
  const values = keys.map((k) => defaults[k]);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
  const inserted = await pool.query(`INSERT INTO ai_trade_plans(${keys.join(',')}) VALUES(${placeholders}) RETURNING *`, values);
  return inserted.rows[0] as Record<string, unknown>;
}

describe.skipIf(SKIP)('AI trade plan watcher reconciliation', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await pool.query(`DELETE FROM trade_outcomes WHERE symbol LIKE 'TEST%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TEST%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TEST%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('expires WAITING_FOR_APPROVAL plans past plan_expiry without ever touching MT5', async () => {
    const plan = await insertPlan(pool, {
      symbol: 'TESTUNAPPROVED', status: 'WAITING_FOR_APPROVAL', mt5_order_ticket: null,
      plan_expiry: new Date(Date.now() - 1000).toISOString(),
    });
    await expireUnapprovedPlans(pool);
    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PLAN_EXPIRED');
    expect(mt5Client.cancelMt5PendingOrder).not.toHaveBeenCalled();
  });

  it('reconciles a triggered pending order into an open position via trade_outcomes', async () => {
    const plan = await insertPlan(pool, { symbol: 'TESTTRIGGERED' });
    const comment = planComment(plan.id);
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]); // ticket no longer pending
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([
      { ticket: 900123, symbol: 'TESTTRIGGERED', comment, price_open: 1881.2, volume: 0.1 },
    ] as never);

    await reconcilePendingOrders(pool, ACTOR);

    const row = await pool.query('SELECT status, mt5_position_ticket, actual_entry FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_position_ticket).toBe('900123');
    const outcome = await pool.query('SELECT * FROM trade_outcomes WHERE ai_trade_plan_id=$1', [plan.id]);
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0].order_ticket).toBe('900123');
  });

  it('cancels an expired-but-still-pending order in MT5 rather than leaving it active indefinitely', async () => {
    const plan = await insertPlan(pool, { symbol: 'TESTSTILLPENDING', plan_expiry: new Date(Date.now() - 1000).toISOString() });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([{ ticket: 444555, symbol: 'TESTSTILLPENDING' }] as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
    vi.mocked(mt5Client.cancelMt5PendingOrder).mockResolvedValue({ retcode: 10009 } as never);

    await reconcilePendingOrders(pool, ACTOR);

    expect(mt5Client.cancelMt5PendingOrder).toHaveBeenCalledWith('444555', ACTOR.requestId);
    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PLAN_EXPIRED');
  });

  it('marks a pending order ORDER_CANCELLED when MT5 no longer shows it as pending or as a position (broker-side cancel)', async () => {
    const plan = await insertPlan(pool, { symbol: 'TESTBROKERCANCEL' });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);

    await reconcilePendingOrders(pool, ACTOR);

    const row = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('ORDER_CANCELLED');
    expect(row.rows[0].blocked_reason).toBe('MT5_ORDER_NO_LONGER_PENDING');
  });

  it('leaves a genuinely still-pending order untouched', async () => {
    const plan = await insertPlan(pool, { symbol: 'TESTSTILLLIVE' });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([{ ticket: 444555, symbol: 'TESTSTILLLIVE' }] as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);

    await reconcilePendingOrders(pool, ACTOR);

    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(mt5Client.cancelMt5PendingOrder).not.toHaveBeenCalled();
  });

  it('recovers a crash-stuck PENDING_ORDER_SUBMITTING plan by finding its real MT5 pending order', async () => {
    const plan = await insertPlan(pool, {
      symbol: 'TESTSTUCKORDER', status: 'PENDING_ORDER_SUBMITTING', mt5_order_ticket: null,
      execution_key: 'stuck-key', submitting_at: new Date(Date.now() - 200_000).toISOString(),
    });
    const comment = planComment(plan.id);
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([{ ticket: 321, symbol: 'TESTSTUCKORDER', comment }] as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);

    await reconcileStuckSubmissions(pool, ACTOR, 120);

    const row = await pool.query('SELECT status, mt5_order_ticket, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(row.rows[0].mt5_order_ticket).toBe('321');
    expect(row.rows[0].execution_key).toBeNull();
  });

  it('releases a crash-stuck plan back to WAITING_FOR_APPROVAL when MT5 shows no evidence of it', async () => {
    const plan = await insertPlan(pool, {
      symbol: 'TESTSTUCKNONE', status: 'PENDING_ORDER_SUBMITTING', mt5_order_ticket: null,
      execution_key: 'stuck-key', submitting_at: new Date(Date.now() - 200_000).toISOString(),
    });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);

    await reconcileStuckSubmissions(pool, ACTOR, 120);

    const row = await pool.query('SELECT status, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('WAITING_FOR_APPROVAL');
    expect(row.rows[0].execution_key).toBeNull();
  });

  it('never mutates the Trade Score recorded at decision time — history must reflect the score AS IT WAS, not be recalculated later', async () => {
    const plan = await insertPlan(pool, {
      symbol: 'TESTSCOREFROZEN', trade_score: 82, trade_rating: 'GOOD',
      score_breakdown: JSON.stringify({ trend: 18, momentum: 15, entryQuality: 17, riskReward: 18, marketConditions: 14 }),
    });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([{ ticket: 444555, symbol: 'TESTSCOREFROZEN' }] as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);

    await runAiTradePlanWatcherTick(pool, ACTOR);

    const row = await pool.query('SELECT trade_score, trade_rating, score_breakdown FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(Number(row.rows[0].trade_score)).toBe(82);
    expect(row.rows[0].trade_rating).toBe('GOOD');
    expect(row.rows[0].score_breakdown).toEqual({ trend: 18, momentum: 15, entryQuality: 17, riskReward: 18, marketConditions: 14 });
  });

  it('a full watcher tick runs all reconciliation steps without throwing when MT5 is unreachable', async () => {
    vi.mocked(mt5Client.listMt5PendingOrders).mockRejectedValue(new Error('MT5 unreachable'));
    vi.mocked(mt5Client.listMt5Positions).mockRejectedValue(new Error('MT5 unreachable'));
    await expect(runAiTradePlanWatcherTick(pool, ACTOR)).resolves.toBeUndefined();
  });
});
