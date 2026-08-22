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
  sendMt5Order: vi.fn(),
  sendMt5PendingOrder: vi.fn(),
  checkMt5Order: vi.fn(),
  checkMt5PendingOrder: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import { approveAndPlaceAiTradePlan } from '../services/trading-ai/trading-ai-service';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

describe.skipIf(SKIP)('one active real DEMO plan per symbol (spec section 12)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.MT5_ONE_ACTIVE_PLAN_PER_SYMBOL;
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTDUPGUARD%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTDUPGUARD%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedPlan(symbol: string, status: string): Promise<string> {
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','MANUAL') RETURNING id`,
      [symbol],
    );
    const planRow = await pool.query(
      `INSERT INTO ai_trade_plans(analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, entry_type, pending_order_type,
         entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
       VALUES($1,$2,'FOREX','openai','gpt-test','TEST','BUY','MARKET_NOW','NONE',
         1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY',$3)
       RETURNING id`,
      [runRow.rows[0].id, symbol, status],
    );
    return planRow.rows[0].id as string;
  }

  function mockMt5Happy() {
    vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: true, account: { leverage: 100 }, terminal: {} } as never);
    vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1.1, ask: 1.1001, time: Math.floor(Date.now() / 1000) } as never);
    vi.mocked(mt5Client.getMt5MarketStatus).mockResolvedValue({ market_status: 'OPEN', data_status: 'LIVE' } as never);
    vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue({ point: 0.00001, digits: 5, trade_mode: 4 } as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  }

  it('blocks approval when another plan for the same symbol is already PENDING_ORDER_PLACED', async () => {
    mockMt5Happy();
    await seedPlan('TESTDUPGUARD', 'PENDING_ORDER_PLACED');
    const newPlanId = await seedPlan('TESTDUPGUARD', 'WAITING_FOR_APPROVAL');

    const outcome = await approveAndPlaceAiTradePlan(pool, newPlanId, ACTOR);
    expect(outcome.allowed).toBe(false);
    expect(outcome.code).toBe('EXECUTION_FAILED');
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();

    const saved = await pool.query('SELECT status, blocked_reason FROM ai_trade_plans WHERE id=$1', [newPlanId]);
    expect(saved.rows[0].status).toBe('EXECUTION_FAILED');
    expect(saved.rows[0].blocked_reason).toBe('ANOTHER_PLAN_ACTIVE_FOR_SYMBOL');
  });

  it('blocks approval when another plan for the same symbol is POSITION_OPEN', async () => {
    mockMt5Happy();
    await seedPlan('TESTDUPGUARD', 'POSITION_OPEN');
    const newPlanId = await seedPlan('TESTDUPGUARD', 'WAITING_FOR_APPROVAL');
    const outcome = await approveAndPlaceAiTradePlan(pool, newPlanId, ACTOR);
    expect(outcome.allowed).toBe(false);
  });

  it('does not block approval when the flag is disabled', async () => {
    process.env.MT5_ONE_ACTIVE_PLAN_PER_SYMBOL = 'false';
    mockMt5Happy();
    vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 10009, order: 111, deal: 222 } as never);
    await seedPlan('TESTDUPGUARD', 'PENDING_ORDER_PLACED');
    const newPlanId = await seedPlan('TESTDUPGUARD', 'WAITING_FOR_APPROVAL');
    const outcome = await approveAndPlaceAiTradePlan(pool, newPlanId, ACTOR);
    // Never blocked by the duplicate-symbol guard specifically (the flag is
    // off) — whatever else happens downstream is unrelated to this test.
    const saved = await pool.query('SELECT blocked_reason FROM ai_trade_plans WHERE id=$1', [newPlanId]);
    expect(saved.rows[0].blocked_reason).not.toBe('ANOTHER_PLAN_ACTIVE_FOR_SYMBOL');
    void outcome;
  });

  it('does not block approval when no other plan for the symbol is active', async () => {
    mockMt5Happy();
    vi.mocked(mt5Client.sendMt5Order).mockResolvedValue({ retcode: 10009, order: 111, deal: 222 } as never);
    const newPlanId = await seedPlan('TESTDUPGUARD', 'WAITING_FOR_APPROVAL');
    const outcome = await approveAndPlaceAiTradePlan(pool, newPlanId, ACTOR);
    const saved = await pool.query('SELECT blocked_reason FROM ai_trade_plans WHERE id=$1', [newPlanId]);
    expect(saved.rows[0].blocked_reason).not.toBe('ANOTHER_PLAN_ACTIVE_FOR_SYMBOL');
    void outcome;
  });
});
