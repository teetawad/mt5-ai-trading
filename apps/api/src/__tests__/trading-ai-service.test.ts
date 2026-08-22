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
  getMt5HistoryOrders: vi.fn(),
  getMt5HistoryDeals: vi.fn(),
  checkMt5Order: vi.fn(),
  sendMt5Order: vi.fn(),
  checkMt5PendingOrder: vi.fn(),
  sendMt5PendingOrder: vi.fn(),
  cancelMt5PendingOrder: vi.fn(),
  getMt5Bars: vi.fn(),
  getMt5Chart: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import { TradingEngineError } from '../services/trading-engine-client';
import { approveAndPlaceAiTradePlan, cancelAiTradePlanOrder } from '../services/trading-ai/trading-ai-service';
import { planComment } from '../services/trading-ai/plan-comment';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

const DEMO_STATUS = {
  connected: true,
  demo_verified: true,
  account: { login: 60124487, server: 'TradeMaxGlobal-Demo', equity: '10000', balance: '10000', margin_free: '9000', free_margin: '9000', leverage: 1000 },
  terminal: { trade_allowed: true },
};

const OPEN_LIVE_MARKET = { market_status: 'OPEN', data_status: 'LIVE', quote_age_seconds: 1 };

const SYMBOL_INFO = {
  point: 0.01, trade_tick_size: 0.01, trade_stops_level: 0, trade_freeze_level: 0,
  volume_min: 0.01, volume_max: 50, volume_step: 0.01,
  trade_contract_size: 1, trade_tick_value: 0.01, trade_tick_value_profit: 0.01, trade_tick_value_loss: 0.01,
};

function mockHappyPath(overrides: { tick?: Record<string, unknown>; market?: Record<string, unknown> } = {}) {
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue(DEMO_STATUS as never);
  vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1900, ask: 1900.2, ...overrides.tick } as never);
  vi.mocked(mt5Client.getMt5MarketStatus).mockResolvedValue({ ...OPEN_LIVE_MARKET, ...overrides.market } as never);
  vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue(SYMBOL_INFO as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  vi.mocked(mt5Client.getMt5HistoryOrders).mockResolvedValue([]);
  vi.mocked(mt5Client.getMt5HistoryDeals).mockResolvedValue([]);
  vi.mocked(mt5Client.checkMt5Order).mockResolvedValue({ retcode: 10009 } as never);
  vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({
    retcode: 10009, order: 555111, deal: 555222,
    confirmed_position: { ticket: 555111, price_open: 1900.0, volume: 0.12 },
  } as never);
  vi.mocked(mt5Client.checkMt5PendingOrder).mockResolvedValue({ retcode: 0 } as never);
  vi.mocked(mt5Client.sendMt5PendingOrder).mockResolvedValue({ retcode: 10008, order: 777111 } as never);
  vi.mocked(mt5Client.cancelMt5PendingOrder).mockResolvedValue({ retcode: 10009 } as never);
}

async function insertPlan(pool: Pool, overrides: Partial<Record<string, unknown>> = {}) {
  const runRow = await pool.query(
    `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, opportunity_score)
     VALUES($1,'CRYPTO_CFD','anthropic','claude-sonnet-5','TRADING_AI_V3_PROMPT_001','{}'::jsonb,$2,70,75)
     RETURNING id`,
    [overrides.symbol ?? 'TESTETHUSD', overrides.decision ?? 'BUY'],
  );
  const defaults: Record<string, unknown> = {
    analysis_run_id: runRow.rows[0].id,
    symbol: 'TESTETHUSD',
    asset_class: 'CRYPTO_CFD',
    ai_provider: 'anthropic',
    ai_model: 'claude-sonnet-5',
    ai_prompt_version: 'TRADING_AI_V3_PROMPT_001',
    decision: 'BUY',
    confidence_pct: 70,
    opportunity_score: 75,
    trend: 'BULLISH',
    entry_type: 'MARKET_NOW',
    entry_price: 1900,
    entry_zone_low: null,
    entry_zone_high: null,
    trigger_price: null,
    pending_order_type: 'NONE',
    stop_loss: 1890.66,
    take_profit: 1925.89,
    risk_reward: 2.5,
    recommended_volume: 0.12,
    plan_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    reason_summary: 'test plan',
    risk_result: 'PASS',
    status: 'WAITING_FOR_APPROVAL',
    ...overrides,
  };
  const keys = Object.keys(defaults);
  const values = keys.map((k) => defaults[k]);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
  const inserted = await pool.query(
    `INSERT INTO ai_trade_plans(${keys.join(',')}) VALUES(${placeholders}) RETURNING *`,
    values,
  );
  return inserted.rows[0] as Record<string, unknown>;
}

describe.skipIf(SKIP)('Trading AI plan execution', () => {
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

  it('places a real MT5 market order for MARKET_NOW and marks POSITION_OPEN', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, { symbol: 'TESTMARKETNOW' });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(mt5Client.sendMt5Order).toHaveBeenCalledTimes(1);
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, mt5_order_ticket FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_order_ticket).toBe('555111');
  });

  it('places a real MT5 BUY_LIMIT pending order for PULLBACK and marks PENDING_ORDER_PLACED', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTPULLBACK', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
    const call = vi.mocked(mt5Client.sendMt5PendingOrder).mock.calls[0][0];
    expect(call.order_type).toBe('BUY_LIMIT');
    const row = await pool.query('SELECT status, mt5_order_ticket FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(row.rows[0].mt5_order_ticket).toBe('777111');
  });

  it('places a SELL_STOP pending order for a BREAKOUT SELL plan', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTBREAKOUT', decision: 'SELL', entry_type: 'BREAKOUT', pending_order_type: 'SELL_STOP',
      entry_price: null, trigger_price: 1880, stop_loss: 1895, take_profit: 1850,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    const call = vi.mocked(mt5Client.sendMt5PendingOrder).mock.calls[0][0];
    expect(call.order_type).toBe('SELL_STOP');
  });

  it('a high stored Trade Score never overrides a Risk Engine block (Risk Engine is re-checked fresh, unconditionally)', async () => {
    mockHappyPath({ market: { data_status: 'STALE' } });
    const plan = await insertPlan(pool, { symbol: 'TESTHIGHSCOREBLOCK', trade_score: 96, trade_rating: 'STRONG' });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, trade_score FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).not.toBe('POSITION_OPEN');
    expect(Number(row.rows[0].trade_score)).toBe(96); // the score itself is preserved for audit, just never consulted for the gate.
  });

  it('blocks approval when the Risk Engine rejects (e.g. spread/margin conditions changed)', async () => {
    mockHappyPath({ market: { data_status: 'STALE' } });
    const plan = await insertPlan(pool, { symbol: 'TESTRISKBLOCK' });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('EXECUTION_FAILED');
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('EXECUTION_FAILED');
  });

  it('blocks approval when a duplicate open position already exists for the symbol', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([{ symbol: 'TESTDUP' }] as never);
    const plan = await insertPlan(pool, { symbol: 'TESTDUP' });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('EXECUTION_FAILED');
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
  });

  it('prevents double execution: a second approve call on an already-submitting plan cannot also claim it', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, { symbol: 'TESTDOUBLE', status: 'PENDING_ORDER_SUBMITTING', execution_key: 'already-claimed' });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toContain('NOT_CLAIMABLE');
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
  });

  it('accepted pending result with a valid result.order confirms immediately (no reconciliation needed)', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockResolvedValue({ retcode: 10008, order: 424242, request_id: 7 } as never);
    const plan = await insertPlan(pool, {
      symbol: 'TESTVALIDTICKET', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    const row = await pool.query('SELECT status, mt5_order_ticket, mt5_request_id FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(row.rows[0].mt5_order_ticket).toBe('424242');
    expect(row.rows[0].mt5_request_id).toBe('7');
  });

  // Perf fix: the trading engine's own synchronous check is now short, so
  // PENDING_ORDER_NOT_CONFIRMED from it is no longer a definite failure —
  // it means "not found within the fast pass", and the plan is resolved a
  // few seconds later by a bounded, non-blocking background pass instead
  // (see scheduleBackgroundPendingOrderReconciliation), never a second
  // order_send.
  it('an engine-side PENDING_ORDER_NOT_CONFIRMED (order=0, fast reconciliation found nothing) returns PENDING_CONFIRMATION immediately, never blocking the request', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_NOT_CONFIRMED: no matching order found', 409, 'PENDING_ORDER_NOT_CONFIRMED', undefined),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTNOTCONFIRMED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(outcome.code).toBe('PENDING_CONFIRMATION');
    const row = await pool.query('SELECT status, blocked_reason, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
    // Not yet resolved — the background pass is still in flight; never a
    // second order_send while this is true (execution_key still locked).
    expect(row.rows[0].status).toBe('PENDING_ORDER_SUBMITTING');
    expect(row.rows[0].blocked_reason).toBeNull();
    expect(row.rows[0].execution_key).not.toBeNull();
    expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
  });

  // These three use REAL, short delays (env override) rather than
  // vi.useFakeTimers() — faking global timers while real pg I/O (which uses
  // its own internal timers/microtasks) is in flight is a known source of
  // flaky async races, and the whole point here is exercising the real,
  // unmocked setTimeout-chained background pass end to end.
  const REAL_DELAYS_MS = '15,15,15,15'; // cumulative ~60ms — plenty for a local test DB
  function waitPastBackgroundWindow(extraMs = 150) {
    return new Promise((resolve) => setTimeout(resolve, extraMs));
  }

  it('background reconciliation resolves a PENDING_CONFIRMATION plan to EXECUTION_FAILED/PENDING_ORDER_NOT_CONFIRMED after the full bounded window finds nothing, without ever resending order_send', async () => {
    process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS = REAL_DELAYS_MS;
    try {
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
        new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_NOT_CONFIRMED: no matching order found', 409, 'PENDING_ORDER_NOT_CONFIRMED', undefined),
      );
      const plan = await insertPlan(pool, {
        symbol: 'TESTBGNOTCONFIRMED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
        entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
      });
      const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
      expect(outcome.code).toBe('PENDING_CONFIRMATION');

      // mockHappyPath already mocks listMt5PendingOrders/listMt5Positions/
      // getMt5HistoryOrders/getMt5HistoryDeals as empty — the background
      // pass finds nothing at every one of its bounded checks.
      await waitPastBackgroundWindow();

      const row = await pool.query('SELECT status, blocked_reason, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('EXECUTION_FAILED');
      expect(row.rows[0].blocked_reason).toBe('PENDING_ORDER_NOT_CONFIRMED');
      expect(row.rows[0].execution_key).toBeNull();
      // The one and only order_send call ever made for this plan.
      expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS;
    }
  });

  it('background reconciliation resolves a PENDING_CONFIRMATION plan to PENDING_ORDER_PLACED once the broker registers the order a moment later', async () => {
    process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS = REAL_DELAYS_MS;
    try {
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
        new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_NOT_CONFIRMED: no matching order found', 409, 'PENDING_ORDER_NOT_CONFIRMED', undefined),
      );
      const plan = await insertPlan(pool, {
        symbol: 'TESTBGLATEORDER', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
        entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
      });
      const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
      expect(outcome.code).toBe('PENDING_CONFIRMATION');

      // The broker only registers the pending order a little while after
      // order_send returned — simulated by the live listing mock starting
      // to report it partway through the background pass.
      vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([
        { ticket: 888222, symbol: 'TESTBGLATEORDER', comment: planComment(String(plan.id)) } as never,
      ]);

      await waitPastBackgroundWindow();

      const row = await pool.query('SELECT status, mt5_order_ticket, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
      expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
      expect(row.rows[0].mt5_order_ticket).toBe('888222');
      expect(row.rows[0].execution_key).toBeNull();
      expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS;
    }
  });

  it('a second approve click while PENDING_CONFIRMATION is still resolving never sends a second order_send', async () => {
    process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS = REAL_DELAYS_MS;
    try {
      mockHappyPath();
      vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
        new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_NOT_CONFIRMED: no matching order found', 409, 'PENDING_ORDER_NOT_CONFIRMED', undefined),
      );
      const plan = await insertPlan(pool, {
        symbol: 'TESTBGDOUBLECLICK', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
        entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
      });
      const first = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
      expect(first.code).toBe('PENDING_CONFIRMATION');

      // A second click while the background pass is still in flight — the
      // plan is still PENDING_ORDER_SUBMITTING, so it can never be
      // re-claimed via WAITING_FOR_APPROVAL, and no evidence exists yet for
      // checkAlreadyPlacedOnConflict to report ALREADY_PLACED either.
      const second = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
      expect(second.allowed).toBe(false);
      expect(second.code).toBe('NOT_CLAIMABLE_PENDING_ORDER_SUBMITTING');

      await waitPastBackgroundWindow();
      expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS;
    }
  });

  it('an engine-side PENDING_ORDER_CONFIRMATION_AMBIGUOUS blocks the plan and never guesses a ticket', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_CONFIRMATION_AMBIGUOUS: 2 possible matches', 409, 'PENDING_ORDER_CONFIRMATION_AMBIGUOUS'),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTAMBIGUOUS', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    const row = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('EXECUTION_FAILED');
    expect(row.rows[0].blocked_reason).toBe('PENDING_ORDER_CONFIRMATION_AMBIGUOUS');
  });

  it('an actually-rejected retcode blocks the plan with the rejection reason', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError('Trading engine MT5 error: 403 PENDING_ORDER_REJECTED: retcode=10006', 403, 'PENDING_ORDER_REJECTED'),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTREJECTED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    const row = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('EXECUTION_FAILED');
    expect(row.rows[0].blocked_reason).toBe('PENDING_ORDER_REJECTED');
  });

  // ---------------------------------------------------------------------
  // Diagnostics capture (debug task: "CAPTURE EXACT ORDER_SEND RESULT") —
  // the engine's own retcode/order/deal/request_id/comment diagnostics must
  // reach the persisted execution_snapshot on EVERY failure path, not just
  // on success, so a case like PENDING_ORDER_NOT_CONFIRMED is always
  // diagnosable from the DB row afterward.
  // ---------------------------------------------------------------------

  it('a rejected retcode persists the engine diagnostics (retcode/retcode_name/request) into execution_snapshot', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError(
        'Trading engine MT5 error: 403 PENDING_ORDER_REJECTED: retcode=10006 (TRADE_RETCODE_REJECT)', 403, 'PENDING_ORDER_REJECTED',
        {
          request: { action: 5, symbol: 'TESTDIAGREJECTED', type: 2, price: 1880, sl: 1870, tp: 1900 },
          order_check: { retcode: 0, retcode_name: 'TRADE_RETCODE_DONE_marker', comment: 'Done' },
          order_send: { retcode: 10006, retcode_name: 'TRADE_RETCODE_REJECT', order: 0, deal: 0, request_id: 99, comment: 'Rejected', last_error: '(1, "no error")' },
        },
      ),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTDIAGREJECTED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect((outcome.plan?.execution_snapshot as Record<string, unknown>)?.order_send).toMatchObject({ retcode: 10006, retcode_name: 'TRADE_RETCODE_REJECT', order: 0, deal: 0, request_id: 99 });
    const row = await pool.query('SELECT execution_snapshot FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].execution_snapshot.order_send.retcode).toBe(10006);
    expect(row.rows[0].execution_snapshot.request.symbol).toBe('TESTDIAGREJECTED');
  });

  it('a PENDING_ORDER_NOT_CONFIRMED result also persists execution_snapshot, never left empty', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError(
        'Trading engine MT5 error: 409 PENDING_ORDER_NOT_CONFIRMED: no matching order found', 409, 'PENDING_ORDER_NOT_CONFIRMED',
        {
          request: { action: 5, symbol: 'TESTDIAGNOTCONFIRMED', type: 2 },
          order_check: { retcode: 0, comment: 'Done' },
          order_send: { retcode: 0, retcode_name: 'BROKER_NONSTANDARD_RETCODE_ZERO', order: 0, deal: 0, request_id: 7, comment: 'Done', last_error: '(1, "no error")', retcode_is_broker_nonstandard_zero: true },
        },
      ),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTDIAGNOTCONFIRMED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    const row = await pool.query('SELECT execution_snapshot FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].execution_snapshot).not.toBeNull();
    expect(row.rows[0].execution_snapshot.order_send.order).toBe(0);
    expect(row.rows[0].execution_snapshot.order_send.request_id).toBe(7);
  });

  it('an order_check retcode rejection (preliminary Node-side check) persists order_check diagnostics', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.checkMt5PendingOrder).mockResolvedValue({
      retcode: 10016, comment: 'Invalid stops', margin: 12.5, margin_free: 987.6, margin_level: 500,
    } as never);
    const plan = await insertPlan(pool, {
      symbol: 'TESTDIAGCHECKFAIL', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT execution_snapshot FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].execution_snapshot.order_check).toMatchObject({ retcode: 10016, comment: 'Invalid stops', margin: 12.5, margin_free: 987.6, margin_level: 500 });
  });

  it('order_check failure blocks the plan before order_send is ever attempted', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.checkMt5PendingOrder).mockRejectedValue(new Error('order_check rejected the pending order request'));
    const plan = await insertPlan(pool, {
      symbol: 'TESTCHECKFAIL', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('EXECUTION_FAILED');
    expect(String(row.rows[0].blocked_reason)).toContain('ORDER_CHECK_FAILED');
  });

  it('a genuine transport-level failure (engine unreachable, no status) leaves the plan for the watcher — never a definite failure', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(new TradingEngineError('Trading engine MT5 unreachable: fetch failed'));
    const plan = await insertPlan(pool, {
      symbol: 'TESTUNREACHABLE', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('EXECUTION_UNCONFIRMED');
    const row = await pool.query('SELECT status, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
    // Deliberately NOT resolved to a terminal state — ai-trade-plan-watcher's
    // reconcileStuckSubmissions is the only thing allowed to resolve this,
    // since the engine's own answer is genuinely unknown.
    expect(row.rows[0].status).toBe('PENDING_ORDER_SUBMITTING');
    expect(row.rows[0].execution_key).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // IMMEDIATE TRIGGER CASE (spec section 6): the trading engine's own
  // reconciliation across orders_get()/positions_get()/history now reports
  // execution_state, so a pending order that triggered (or even
  // filled-and-was-already-confirmed via history) before ever being
  // observed as an active order must land on POSITION_OPEN directly, never
  // PENDING_ORDER_PLACED first.
  // ---------------------------------------------------------------------

  it('an immediate TRIGGERED_POSITION result goes straight to POSITION_OPEN, never PENDING_ORDER_PLACED first', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockResolvedValue({
      retcode: 10008, retcode_name: 'TRADE_RETCODE_PLACED', order: 901, deal: 0,
      execution_state: 'TRIGGERED_POSITION',
      confirmed_position: { ticket: 901, price_open: 1881.5, volume: 0.12 },
    } as never);
    const plan = await insertPlan(pool, {
      symbol: 'TESTTRIGGERED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    const row = await pool.query('SELECT status, mt5_position_ticket, actual_entry, triggered_at FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_position_ticket).toBe('901');
    expect(Number(row.rows[0].actual_entry)).toBe(1881.5);
    expect(row.rows[0].triggered_at).not.toBeNull();
    const outcomeRow = await pool.query('SELECT ai_trade_plan_id FROM trade_outcomes WHERE ai_trade_plan_id=$1', [plan.id]);
    expect(outcomeRow.rowCount).toBe(1);
  });

  it('a FILLED_HISTORY result (order/deal history proved the fill when live endpoints showed nothing) also becomes POSITION_OPEN', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockResolvedValue({
      retcode: 10008, order: 0, deal: 0,
      execution_state: 'FILLED_HISTORY',
      confirmed_history_deal: { ticket: 5001, position_id: 6001, price: 1881.7, volume: 0.12 },
    } as never);
    const plan = await insertPlan(pool, {
      symbol: 'TESTFILLEDHISTORY', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    const row = await pool.query('SELECT status, mt5_position_ticket, actual_entry FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_position_ticket).toBe('6001');
    expect(Number(row.rows[0].actual_entry)).toBe(1881.7);
  });

  it('an engine-side PENDING_ORDER_CANCELLED (history proved a definite cancellation) marks the plan ORDER_CANCELLED, never EXECUTION_FAILED', async () => {
    mockHappyPath();
    vi.mocked(mt5Client.sendMt5PendingOrder).mockRejectedValue(
      new TradingEngineError('Trading engine MT5 error: 409 PENDING_ORDER_CANCELLED: order was CANCELED per history', 409, 'PENDING_ORDER_CANCELLED'),
    );
    const plan = await insertPlan(pool, {
      symbol: 'TESTHISTCANCELLED', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    const row = await pool.query('SELECT status, blocked_reason, cancelled_at FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('ORDER_CANCELLED');
    expect(row.rows[0].blocked_reason).toBe('PENDING_ORDER_CANCELLED');
    expect(row.rows[0].cancelled_at).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // NO BLIND RETRY (spec section 8, CRITICAL): an owner re-clicking approve
  // on a plan that previously ended PENDING_ORDER_NOT_CONFIRMED/AMBIGUOUS
  // must never trigger a second order_send without first reconciling.
  // ---------------------------------------------------------------------

  it('retry after PENDING_ORDER_NOT_CONFIRMED: reconciliation finds a real position via history and reports ALREADY_PLACED without resending', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTRETRYFOUNDPOSITION', status: 'EXECUTION_FAILED', blocked_reason: 'PENDING_ORDER_NOT_CONFIRMED',
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT', entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    vi.mocked(mt5Client.getMt5HistoryDeals).mockResolvedValue([
      { ticket: 7001, position_id: 8001, symbol: 'TESTRETRYFOUNDPOSITION', comment: planComment(plan.id), price: 1881.2, volume: 0.12, entry: 0 },
    ] as never);

    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(outcome.code).toBe('ALREADY_PLACED');
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, mt5_position_ticket FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_position_ticket).toBe('8001');
  });

  it('retry after PENDING_ORDER_NOT_CONFIRMED: truly no evidence anywhere releases the plan and allows a brand-new attempt with a fresh execution_key', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTRETRYFRESH', status: 'EXECUTION_FAILED', blocked_reason: 'PENDING_ORDER_NOT_CONFIRMED',
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT', entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    // Second attempt succeeds cleanly this time.
    vi.mocked(mt5Client.sendMt5PendingOrder).mockResolvedValue({ retcode: 10008, order: 909090 } as never);

    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(mt5Client.sendMt5PendingOrder).toHaveBeenCalledTimes(1);
    const row = await pool.query('SELECT status, mt5_order_ticket, execution_key FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(row.rows[0].mt5_order_ticket).toBe('909090');
  });

  it('retry after PENDING_ORDER_CONFIRMATION_AMBIGUOUS: never auto-resets or resends even with no fresh evidence — stays blocked for review', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTRETRYAMBIGUOUS', status: 'EXECUTION_FAILED', blocked_reason: 'PENDING_ORDER_CONFIRMATION_AMBIGUOUS',
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT', entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });

    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toContain('NOT_CLAIMABLE');
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('EXECUTION_FAILED');
    expect(row.rows[0].blocked_reason).toBe('PENDING_ORDER_CONFIRMATION_AMBIGUOUS');
  });

  it('duplicate retry protection: a plan stuck PENDING_ORDER_SUBMITTING with a real matching MT5 order returns ALREADY_PLACED and never resends', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTALREADYPLACED', status: 'PENDING_ORDER_SUBMITTING', execution_key: 'stuck-key',
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT', entry_price: null, entry_zone_low: 1880, entry_zone_high: 1890,
    });
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([
      { ticket: 314159, symbol: 'TESTALREADYPLACED', comment: planComment(plan.id) },
    ] as never);

    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(outcome.code).toBe('ALREADY_PLACED');
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
    expect(mt5Client.checkMt5PendingOrder).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, mt5_order_ticket FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PENDING_ORDER_PLACED');
    expect(row.rows[0].mt5_order_ticket).toBe('314159');
  });

  it('duplicate retry protection: a plan stuck PENDING_ORDER_SUBMITTING with a real matching MT5 position also returns ALREADY_PLACED', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, {
      symbol: 'TESTALREADYPOSITION', status: 'PENDING_ORDER_SUBMITTING', execution_key: 'stuck-key-2',
      entry_type: 'MARKET_NOW', entry_price: 1900,
    });
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([
      { ticket: 271828, symbol: 'TESTALREADYPOSITION', comment: planComment(plan.id), price_open: 1900.5 },
    ] as never);

    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(outcome.code).toBe('ALREADY_PLACED');
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    const row = await pool.query('SELECT status, mt5_position_ticket FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('POSITION_OPEN');
    expect(row.rows[0].mt5_position_ticket).toBe('271828');
  });

  it('two different plans get two different unique execution-key comments', async () => {
    const planA = await insertPlan(pool, { symbol: 'TESTUNIQUEA' });
    const planB = await insertPlan(pool, { symbol: 'TESTUNIQUEB' });
    expect(planComment(planA.id)).not.toBe(planComment(planB.id));
    expect(planComment(planA.id)).toMatch(/^AIV3[0-9a-f]{12}$/);
  });

  it('refuses to approve a plan that already expired', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, { symbol: 'TESTEXPIRED', plan_expiry: new Date(Date.now() - 1000).toISOString() });
    const outcome = await approveAndPlaceAiTradePlan(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('PLAN_EXPIRED');
    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('PLAN_EXPIRED');
  });

  it('cancels a placed pending order through DemoExecutionGateway and marks ORDER_CANCELLED', async () => {
    mockHappyPath();
    const plan = await insertPlan(pool, { symbol: 'TESTCANCEL', status: 'PENDING_ORDER_PLACED', mt5_order_ticket: '999888' });
    const outcome = await cancelAiTradePlanOrder(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(true);
    expect(mt5Client.cancelMt5PendingOrder).toHaveBeenCalledWith('999888', ACTOR.requestId);
    const row = await pool.query('SELECT status FROM ai_trade_plans WHERE id=$1', [plan.id]);
    expect(row.rows[0].status).toBe('ORDER_CANCELLED');
  });

  it('refuses to cancel a plan that has no placed pending order', async () => {
    const plan = await insertPlan(pool, { symbol: 'TESTNOTPLACED', status: 'WAITING_FOR_APPROVAL' });
    const outcome = await cancelAiTradePlanOrder(pool, String(plan.id), ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('NOT_CANCELLABLE');
    expect(mt5Client.cancelMt5PendingOrder).not.toHaveBeenCalled();
  });
});
