import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';
import { createShadowTradesForCycle } from '../services/trading-ai/shadow-trade-service';
import { ScanResultRow } from '../services/trading-ai/opportunity-scan';
import { MarketAnalysisPackage } from '../services/trading-ai/types';

const SKIP = !process.env.TEST_DATABASE_URL;

// Shadow trade creation must never be able to place a real MT5 order — this
// is enforced structurally (the module never imports mt5-client's order
// functions at all), so a static source check is a meaningful regression
// guard: if a future edit ever adds such an import, this test fails.
describe('shadow-trade-service — never calls order_send by construction', () => {
  it('never imports mt5-client.ts (the only module that can call order_send)', () => {
    const source = readFileSync(path.resolve(__dirname, '../services/trading-ai/shadow-trade-service.ts'), 'utf-8');
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(importLines.some((line) => line.includes('mt5-client'))).toBe(false);
  });
});

function makePkg(overrides: Partial<MarketAnalysisPackage['quote']> = {}): MarketAnalysisPackage {
  return {
    symbol: 'TESTSHADOWSYM',
    assetClass: 'FOREX',
    generatedAt: new Date().toISOString(),
    quote: { bid: 1.1, ask: 1.1002, spread: 0.0002, digits: 5, point: 0.00001, quoteAgeSeconds: 1, ...overrides },
    market: { status: 'OPEN', dataStatus: 'LIVE', sessionOpen: null, sessionClose: null, nextOpen: null },
    timeframes: [
      { timeframe: 'M5', barCount: 220, lastClosedTime: new Date().toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, tickVolume: 100, sma20: 1.1, sma50: 1.1, ema20: 1.1, ema50: 1.1, rsi14: 55, atr14: 0.001, macd: 0, macdSignal: 0, macdHistogram: 0, recentHigh: 1.11, recentLow: 1.09, supportResistance: [1.105, 1.095], trend: 'BULLISH' },
      { timeframe: 'M15', barCount: 220, lastClosedTime: new Date().toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1, tickVolume: 100, sma20: 1.1, sma50: 1.1, ema20: 1.1, ema50: 1.1, rsi14: 55, atr14: 0.002, macd: 0, macdSignal: 0, macdHistogram: 0, recentHigh: 1.11, recentLow: 1.09, supportResistance: [1.105, 1.095], trend: 'BULLISH' },
      { timeframe: 'H1', barCount: 220, lastClosedTime: new Date().toISOString(), open: 1.1, high: 1.102, low: 1.098, close: 1.1, tickVolume: 100, sma20: 1.1, sma50: 1.1, ema20: 1.1, ema50: 1.1, rsi14: 55, atr14: 0.003, macd: 0, macdSignal: 0, macdHistogram: 0, recentHigh: 1.11, recentLow: 1.09, supportResistance: [], trend: 'BULLISH' },
      { timeframe: 'H4', barCount: 220, lastClosedTime: new Date().toISOString(), open: 1.1, high: 1.103, low: 1.097, close: 1.1, tickVolume: 100, sma20: 1.1, sma50: 1.1, ema20: 1.1, ema50: 1.1, rsi14: 55, atr14: 0.004, macd: 0, macdSignal: 0, macdHistogram: 0, recentHigh: 1.11, recentLow: 1.09, supportResistance: [], trend: 'BULLISH' },
    ],
    account: { balance: 10000, equity: 10000, freeMargin: 9000, currency: 'USD' },
    existingPosition: { exists: false },
    existingPendingOrder: { exists: false },
  };
}

function row(overrides: Partial<ScanResultRow> = {}): ScanResultRow {
  return {
    symbol: 'TESTSHADOWSYM', assetClass: 'FOREX', decision: 'BUY', action: 'ENTER_NOW', actionReason: 'MARKET_ENTRY_READY', confidencePct: 70,
    tradeabilityPct: 70, tradeabilityRating: 'GOOD', tradeabilityRatingLabelTh: null, profitabilityScore: 70,
    tradeScore: 70, tradeRating: 'GOOD', tradeRatingLabelTh: null,
    entryType: 'MARKET_NOW', pendingOrderType: 'NONE', currentPrice: 1.1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    planExpiry: null, planId: null, riskResult: 'PASS', riskFailedRules: null, riskReward: 2,
    maxLoss: '10.00000000', targetProfit: '20.00000000', marginRequired: null, freeMargin: null, marginShortfall: null,
    aiProvider: 'openai', aiModel: 'gpt-test', aiPromptVersion: 'TEST',
    reasonSummary: 'test', error: null, reused: false, shadowTradeActive: false, shadowTradeStatus: null,
    side: 'BUY', recommendedVolume: '0.10000000', demoExecutionReady: true, blockReasons: [], brokerPreflightPass: true, executableNow: true,
    technicalValid: true, technicalBlockCode: null, technicalBlockMessage: null,
    ...overrides,
  };
}

describe.skipIf(SKIP)('createShadowTradesForCycle', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM shadow_trades WHERE symbol LIKE 'TESTSHADOW%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTSHADOW%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTSHADOW%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedPlan(symbol: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason, trigger_source)
       VALUES($1,'FOREX','openai','gpt-test','TEST_PROMPT','{}'::jsonb,'BUY',70,70,70,'ENTER_NOW','MARKET_ENTRY_READY','M5_CYCLE') RETURNING id`,
      [symbol],
    );
    const fields: Record<string, unknown> = {
      analysis_run_id: runRow.rows[0].id, symbol, asset_class: 'FOREX', ai_provider: 'openai', ai_model: 'gpt-test', ai_prompt_version: 'TEST',
      decision: 'BUY', entry_type: 'MARKET_NOW', pending_order_type: 'NONE',
      entry_price: 1.1, stop_loss: 1.09, take_profit: 1.12, risk_reward: 2,
      max_planned_loss: '10.00000000', target_profit: '20.00000000',
      plan_expiry: new Date(Date.now() + 30 * 60_000).toISOString(),
      risk_result: 'PASS', action: 'ENTER_NOW', action_reason: 'MARKET_ENTRY_READY', status: 'WAITING_FOR_APPROVAL',
      ...overrides,
    };
    const cols = Object.keys(fields);
    const values = Object.values(fields);
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const planRow = await pool.query(`INSERT INTO ai_trade_plans(${cols.join(',')}) VALUES(${placeholders.join(',')}) RETURNING id`, values);
    return planRow.rows[0].id as string;
  }

  it('ENTER_NOW creates an immediately-ENTERED shadow trade at the correct bid/ask side (BUY -> ask)', async () => {
    const planId = await seedPlan('TESTSHADOWSYM');
    const pkg = makePkg({ bid: 1.1, ask: 1.1002 });
    const result = await createShadowTradesForCycle(pool, [row({ planId })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    expect(result.created).toBe(1);

    const saved = await pool.query('SELECT * FROM shadow_trades WHERE ai_trade_plan_id = $1', [planId]);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].status).toBe('ENTERED');
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.1002);
    expect(saved.rows[0].entered_at).not.toBeNull();
  });

  it('ENTER_NOW for a SELL uses the bid side', async () => {
    const planId = await seedPlan('TESTSHADOWSYM', { decision: 'SELL' });
    const pkg = makePkg({ bid: 1.1, ask: 1.1002 });
    await createShadowTradesForCycle(pool, [row({ planId, decision: 'SELL' })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE ai_trade_plan_id = $1', [planId]);
    expect(Number(saved.rows[0].actual_shadow_entry)).toBe(1.1);
  });

  it('WAIT_FOR_ENTRY creates an AWAITING_TRIGGER shadow trade with no entry yet', async () => {
    const planId = await seedPlan('TESTSHADOWSYM', {
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT', entry_price: 1.095, trigger_price: 1.095,
    });
    const pkg = makePkg();
    const result = await createShadowTradesForCycle(pool, [row({ planId, action: 'WAIT_FOR_ENTRY', pendingOrderType: 'BUY_LIMIT', entryType: 'PULLBACK' })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    expect(result.created).toBe(1);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE ai_trade_plan_id = $1', [planId]);
    expect(saved.rows[0].status).toBe('AWAITING_TRIGGER');
    expect(saved.rows[0].actual_shadow_entry).toBeNull();
    expect(saved.rows[0].order_type).toBe('BUY_LIMIT');
  });

  it('creating a shadow trade twice for the same plan is a no-op (idempotent)', async () => {
    const planId = await seedPlan('TESTSHADOWSYM');
    const pkg = makePkg();
    const first = await createShadowTradesForCycle(pool, [row({ planId })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    const second = await createShadowTradesForCycle(pool, [row({ planId })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    const saved = await pool.query('SELECT * FROM shadow_trades WHERE ai_trade_plan_id = $1', [planId]);
    expect(saved.rows).toHaveLength(1);
  });

  it('extracts a non-empty feature_snapshot from the MarketAnalysisPackage (spec section 14)', async () => {
    const planId = await seedPlan('TESTSHADOWSYM');
    const pkg = makePkg();
    await createShadowTradesForCycle(pool, [row({ planId })], new Map([['TESTSHADOWSYM', pkg]]), pkg.generatedAt);
    const saved = await pool.query('SELECT feature_snapshot FROM shadow_trades WHERE ai_trade_plan_id = $1', [planId]);
    const snapshot = saved.rows[0].feature_snapshot;
    expect(snapshot.timeframes.M5).toBeDefined();
    expect(snapshot.timeframes.M5.trend).toBe('BULLISH');
    expect(snapshot.riskReward).toBe(2);
  });
});
