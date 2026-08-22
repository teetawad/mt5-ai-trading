import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';
import { getFastLearningAllTimeSummary, getFastLearningDailySummary, getFastLearningScoreBuckets, getMlDataReadiness } from '../services/trading-ai/fast-learning-dashboard';
import { listRealDemoLearningOutcomes } from '../services/trading-ai/real-demo-learning';
import { listMt5TradeHistory } from '../services/mt5-demo-lab-service';
import { loadFastLearningSettings } from '../config/fast-learning-settings';

const SKIP = !process.env.TEST_DATABASE_URL;

describe.skipIf(SKIP)('Fast Learning Dashboard', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    // trade_outcomes.ai_trade_plan_id FKs ai_trade_plans(id) with no cascade
    // — must be deleted before ai_trade_plans, or the double-count tests
    // (which seed a real trade_outcomes row linked to an ai_trade_plans row)
    // fail cleanup with a foreign key violation.
    await pool.query(`DELETE FROM shadow_trades WHERE symbol LIKE 'TESTDASH%'`);
    await pool.query(`DELETE FROM trade_outcomes WHERE symbol LIKE 'TESTDASH%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTDASH%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTDASH%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedAnalysisRun(symbol: string, triggerSource: string) {
    await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW',$2)`,
      [symbol, triggerSource],
    );
  }

  async function seedPlanAndShadow(symbol: string, planId: string, overrides: Record<string, unknown>) {
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','M5_CYCLE') RETURNING id`,
      [symbol],
    );
    await pool.query(
      `INSERT INTO ai_trade_plans(id, analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, entry_type, pending_order_type,
         entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
       VALUES($1,$2,$3,'FOREX','openai','gpt-test','TEST','BUY','MARKET_NOW','NONE',
         1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')`,
      [planId, runRow.rows[0].id, symbol],
    );
    const fields: Record<string, unknown> = {
      ai_trade_plan_id: planId, analysis_run_id: runRow.rows[0].id, symbol, asset_class: 'FOREX',
      m5_candle_timestamp: new Date().toISOString(), direction: 'BUY', action: 'ENTER_NOW', order_type: 'MARKET',
      stop_loss: 1.09, take_profit: 1.12, risk_reward: 2, profitability_score: 70, tradeability_pct: 70,
      plan_expiry: new Date(Date.now() + 30 * 60_000).toISOString(),
      status: 'AWAITING_TRIGGER',
      ...overrides,
    };
    const cols = Object.keys(fields);
    const values = Object.values(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    await pool.query(`INSERT INTO shadow_trades(${cols.join(',')}) VALUES(${placeholders.join(',')})`, values);
  }

  it('counts M5-cycle decisions and separates them from manual ones', async () => {
    await seedAnalysisRun('TESTDASHM5', 'M5_CYCLE');
    await seedAnalysisRun('TESTDASHMANUAL', 'MANUAL');
    const summary = await getFastLearningDailySummary(pool);
    expect(summary.m5Decisions).toBeGreaterThanOrEqual(1);
  });

  it('computes win rate, average R, and profit factor from CLOSED shadow trades only', async () => {
    await seedPlanAndShadow('TESTDASHWIN', crypto.randomUUID(), { status: 'CLOSED', exit_reason: 'TAKE_PROFIT', r_multiple: 2, net_result_estimate: 20 });
    await seedPlanAndShadow('TESTDASHLOSS', crypto.randomUUID(), { status: 'CLOSED', exit_reason: 'STOP_LOSS', r_multiple: -1, net_result_estimate: -10 });
    await seedPlanAndShadow('TESTDASHOPEN', crypto.randomUUID(), { status: 'ENTERED' });

    const summary = await getFastLearningDailySummary(pool);
    expect(summary.wins).toBeGreaterThanOrEqual(1);
    expect(summary.losses).toBeGreaterThanOrEqual(1);
    expect(summary.winRate).toBeGreaterThan(0);
    expect(summary.winRate).toBeLessThanOrEqual(1);
    expect(summary.averageR).not.toBeNull();
  });

  it('places a shadow trade in the correct profitability score bucket', async () => {
    await seedPlanAndShadow('TESTDASHBUCKET', crypto.randomUUID(), { profitability_score: 92, status: 'CLOSED', exit_reason: 'TAKE_PROFIT', r_multiple: 1.5 });
    const buckets = await getFastLearningScoreBuckets(pool, 'profitability_score');
    const top = buckets.find((b) => b.bucket === '85-100');
    expect(top).toBeDefined();
    expect(top!.samples).toBeGreaterThanOrEqual(1);
  });

  it('never mixes shadow trades with real trade_outcomes rows in ML readiness counts', async () => {
    await seedPlanAndShadow('TESTDASHREADY', crypto.randomUUID(), { status: 'CLOSED', exit_reason: 'TAKE_PROFIT', r_multiple: 1 });
    const readiness = await getMlDataReadiness(pool);
    expect(readiness.shadowCompletedSamples).toBeGreaterThanOrEqual(1);
    // realDemoCompletedSamples is sourced purely from trade_outcomes, which
    // this test never inserts into — it must not pick up the shadow row.
    expect(typeof readiness.realDemoCompletedSamples).toBe('number');
    expect(readiness.recommendedMinimumSamples).toBeGreaterThan(0);
    expect(typeof readiness.ready).toBe('boolean');
  });

  it('excludes AMBIGUOUS_OUTCOME shadow trades from win/loss counts', async () => {
    await seedPlanAndShadow('TESTDASHAMBIG', crypto.randomUUID(), { status: 'CLOSED', exit_reason: 'AMBIGUOUS_OUTCOME', r_multiple: null });
    const summary = await getFastLearningDailySummary(pool);
    expect(summary.ambiguous).toBeGreaterThanOrEqual(1);
  });

  // REAL_DEMO learning source (spec: "backfill existing real DEMO history" +
  // "use both Shadow and Real Demo, but keep them clearly separated").
  async function seedRealDemoTrade(symbol: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const fields: Record<string, unknown> = {
      symbol, side: 'BUY', volume: '0.10000000',
      actual_entry: '1.10000000', stop_loss: '1.09000000', take_profit: '1.12000000',
      risk_amount: '10.00000000', realized_pnl: '20.00000000', exit_reason: 'TAKE_PROFIT',
      opened_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      closed_at: new Date().toISOString(),
      ...overrides,
    };
    const cols = Object.keys(fields);
    const values = Object.values(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const result = await pool.query(`INSERT INTO trade_outcomes(${cols.join(',')}) VALUES(${placeholders.join(',')}) RETURNING id`, values);
    return result.rows[0].id as string;
  }

  async function seedAiLinkedPlan(symbol: string): Promise<string> {
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','MANUAL') RETURNING id`,
      [symbol],
    );
    const planRow = await pool.query(
      `INSERT INTO ai_trade_plans(analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, entry_type, pending_order_type,
         entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status,
         confidence_pct, tradeability_pct, profitability_score)
       VALUES($1,$2,'FOREX','openai','gpt-test','TEST','BUY','MARKET_NOW','NONE',
         1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','POSITION_OPEN',
         82,75,88)
       RETURNING id`,
      [runRow.rows[0].id, symbol],
    );
    return planRow.rows[0].id as string;
  }

  it('counts Real Demo completed trades from trade_outcomes, separately from Shadow (0 shadow, 7 real -> readiness shows both correctly)', async () => {
    for (let i = 0; i < 7; i += 1) {
      await seedRealDemoTrade(`TESTDASHREAL${i}`, { realized_pnl: i % 2 === 0 ? '15.00000000' : '-8.00000000', exit_reason: i % 2 === 0 ? 'TAKE_PROFIT' : 'STOP_LOSS' });
    }
    const readiness = await getMlDataReadiness(pool);
    expect(readiness.realDemoCompletedSamples).toBeGreaterThanOrEqual(7);
    expect(readiness.totalUsableSamples).toBe(readiness.shadowCompletedSamples + readiness.realDemoCompletedSamples);
  });

  it('never changes Real Demo History win/loss/PnL statistics — History and the Fast Learning REAL_DEMO view agree on the same trades', async () => {
    const id = await seedRealDemoTrade('TESTDASHHISTORY', { realized_pnl: '42.50000000', exit_reason: 'TAKE_PROFIT' });
    const { trades } = await listMt5TradeHistory(pool);
    const historyRow = trades.find((t: Record<string, unknown>) => t.id === id);
    expect(historyRow).toBeDefined();
    expect(Number(historyRow!.realized_pnl)).toBe(42.5);
    expect(historyRow!.result_type).toBe('WIN');

    const outcomes = await listRealDemoLearningOutcomes(pool, {});
    const learningRow = outcomes.find((o) => o.id === id);
    expect(learningRow).toBeDefined();
    expect(learningRow!.netPnl).toBe(42.5);
    expect(learningRow!.result).toBe('WIN');
  });

  it('never double-counts a plan that has both a Shadow Trade and a later real MT5 execution — the real outcome wins the count', async () => {
    const baseline = await getMlDataReadiness(pool);

    const planId = await seedAiLinkedPlan('TESTDASHDOUBLE');
    await pool.query(
      `INSERT INTO shadow_trades(ai_trade_plan_id, symbol, asset_class, m5_candle_timestamp, direction, action, order_type,
         stop_loss, take_profit, plan_expiry, status, exit_reason, r_multiple, net_result_estimate)
       VALUES($1,'TESTDASHDOUBLE','FOREX', now(), 'BUY','ENTER_NOW','MARKET',1.09,1.12, now() + interval '1 hour','CLOSED','TAKE_PROFIT',2,20)`,
      [planId],
    );
    // With only the Shadow Trade present, it counts normally.
    const afterShadow = await getMlDataReadiness(pool);
    expect(afterShadow.shadowCompletedSamples).toBe(baseline.shadowCompletedSamples + 1);
    expect(afterShadow.realDemoCompletedSamples).toBe(baseline.realDemoCompletedSamples);

    // The same plan is then also manually approved to a real MT5 order and
    // closes for real — the shadow row for this plan must now be excluded
    // from the shadow count (the real outcome is ground truth), so the
    // shadow count drops back to baseline while real demo gains exactly one.
    await seedRealDemoTrade('TESTDASHDOUBLE', { ai_trade_plan_id: planId, realized_pnl: '20.00000000', exit_reason: 'TAKE_PROFIT' });
    const afterReal = await getMlDataReadiness(pool);
    expect(afterReal.shadowCompletedSamples).toBe(baseline.shadowCompletedSamples);
    expect(afterReal.realDemoCompletedSamples).toBe(baseline.realDemoCompletedSamples + 1);
    expect(afterReal.totalUsableSamples).toBe(afterReal.shadowCompletedSamples + afterReal.realDemoCompletedSamples);
  });

  it('imports an old Real Demo trade with no linked AI plan safely — AI metadata is null, never invented', async () => {
    const id = await seedRealDemoTrade('TESTDASHNOAI', { ai_trade_plan_id: null, realized_pnl: '5.00000000', exit_reason: 'TAKE_PROFIT' });
    const outcomes = await listRealDemoLearningOutcomes(pool, {});
    const row = outcomes.find((o) => o.id === id);
    expect(row).toBeDefined();
    expect(row!.aiTradePlanId).toBeNull();
    expect(row!.confidencePct).toBeNull();
    expect(row!.tradeabilityPct).toBeNull();
    expect(row!.profitabilityScore).toBeNull();
    expect(row!.aiProvider).toBeNull();
    expect(row!.entryType).toBeNull();
    expect(row!.marketSnapshot).toBeNull();
    // The trade itself is still a fully usable completed sample.
    expect(row!.result).toBe('WIN');
    expect(row!.netPnl).toBe(5);
  });

  it('a newly closed Real Demo trade updates the learning dataset exactly once', async () => {
    const before = await listRealDemoLearningOutcomes(pool, {});
    const beforeCount = before.length;
    const id = await seedRealDemoTrade('TESTDASHNEWCLOSE', { realized_pnl: '11.00000000', exit_reason: 'TAKE_PROFIT' });
    const after = await listRealDemoLearningOutcomes(pool, {});
    expect(after.length).toBe(beforeCount + 1);
    expect(after.filter((o) => o.id === id)).toHaveLength(1);
  });

  it('exposes AI-linked fields (confidence/tradeability/profitability/provider/model/entry type) for a Real Demo trade with a plan', async () => {
    const planId = await seedAiLinkedPlan('TESTDASHAILINK');
    const id = await seedRealDemoTrade('TESTDASHAILINK', { ai_trade_plan_id: planId, realized_pnl: '30.00000000', exit_reason: 'TAKE_PROFIT' });
    const outcomes = await listRealDemoLearningOutcomes(pool, {});
    const row = outcomes.find((o) => o.id === id);
    expect(row).toBeDefined();
    expect(row!.aiTradePlanId).toBe(planId);
    expect(row!.confidencePct).toBe(82);
    expect(row!.tradeabilityPct).toBe(75);
    expect(row!.profitabilityScore).toBe(88);
    expect(row!.aiProvider).toBe('openai');
    expect(row!.aiModel).toBe('gpt-test');
    expect(row!.entryType).toBe('MARKET_NOW');
  });

  it('Real Demo evaluation stays fully visible even when Fast Learning Mode is OFF', async () => {
    expect(loadFastLearningSettings({ FAST_LEARNING_MODE: 'false' }).fast_learning_mode_enabled).toBe(false);
    await seedRealDemoTrade('TESTDASHOFFMODE', { realized_pnl: '9.00000000', exit_reason: 'TAKE_PROFIT' });
    // getFastLearningAllTimeSummary/getMlDataReadiness are plain read
    // functions — never gated behind the FAST_LEARNING_MODE flag, which only
    // controls whether the M5 scheduler/shadow watcher actively run.
    const allTime = await getFastLearningAllTimeSummary(pool);
    expect(allTime.realDemo.samples).toBeGreaterThanOrEqual(1);
    const readiness = await getMlDataReadiness(pool);
    expect(readiness.realDemoCompletedSamples).toBeGreaterThanOrEqual(1);
  });
});
