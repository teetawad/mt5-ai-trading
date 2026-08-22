import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;

vi.mock('../services/mt5-client', () => ({
  getMt5Status: vi.fn(),
  getMt5MarketStatus: vi.fn(),
  getMt5SymbolInfo: vi.fn(),
  getMt5Tick: vi.fn(),
  getMt5Bars: vi.fn(),
  listMt5Positions: vi.fn(),
  listMt5PendingOrders: vi.fn(),
  sendMt5Order: vi.fn(),
  sendMt5PendingOrder: vi.fn(),
}));

vi.mock('../services/trading-ai/trading-ai-service', () => ({
  analyzeSymbolWithAI: vi.fn(),
  runBrokerPreflight: vi.fn(),
  PROMPT_VERSION: 'TRADING_AI_V3_PROMPT_001',
}));

import * as mt5Client from '../services/mt5-client';
import { analyzeSymbolWithAI, runBrokerPreflight } from '../services/trading-ai/trading-ai-service';
import { runM5OpportunityScan } from '../services/trading-ai/m5-opportunity-scan';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

function makeBars(count: number, basePrice: number, driftPerBar: number, waveAmplitude: number): Record<string, unknown>[] {
  const bars: Record<string, unknown>[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i += 1) {
    const trend = basePrice + driftPerBar * i;
    const wave = Math.sin(i / 6) * waveAmplitude;
    const prevWave = Math.sin((i - 1) / 6) * waveAmplitude;
    const open = trend - driftPerBar + prevWave;
    const close = trend + wave;
    const high = Math.max(open, close) + waveAmplitude * 0.3;
    const low = Math.min(open, close) - waveAmplitude * 0.3;
    bars.push({ time: nowSeconds - (count - i) * 300, open, high, low, close, tick_volume: 100 });
  }
  return bars;
}

const TRENDING_BARS = makeBars(220, 1.1000, 0.00004, 0.0003);

interface SymbolFixture {
  bars?: Record<string, unknown>[];
}

function setupMt5Mocks(fixtures: Record<string, SymbolFixture>) {
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: true, account: {}, terminal: {} } as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  vi.mocked(mt5Client.getMt5MarketStatus).mockImplementation(async (symbol: string) => {
    if (!fixtures[symbol]) return { market_status: 'CLOSED', data_status: 'DISCONNECTED' } as never;
    return { market_status: 'OPEN', data_status: 'LIVE' } as never;
  });
  vi.mocked(mt5Client.getMt5SymbolInfo).mockImplementation(async () => ({ point: 0.00001, digits: 5, trade_mode: 4 } as never));
  vi.mocked(mt5Client.getMt5Tick).mockImplementation(async () => ({ bid: 1.1, ask: 1.1001, time: Math.floor(Date.now() / 1000) } as never));
  vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (symbol: string) => (fixtures[symbol]?.bars ?? []) as never);
  // Default: broker preflight passes so a qualifying candidate's
  // executableNow/real-demo-eligibility isn't accidentally blocked by an
  // unrelated test's expectations. Individual tests override this when they
  // specifically need a broker-preflight failure.
  vi.mocked(runBrokerPreflight).mockResolvedValue({ brokerPreflightPass: true, reason: null });
}

function cannedDetail(overrides: { action: string; profitabilityScore?: number | null; tradeabilityPct?: number | null; confidencePct?: number | null }) {
  return {
    aiConfigured: true,
    decision: { direction: 'BUY', confidencePct: overrides.confidencePct ?? 70, trend: 'BULLISH', marketCondition: 'trending' },
    action: { action: overrides.action, reason: 'TEST', orderIntent: null },
    tradeability: { tradeabilityPct: overrides.tradeabilityPct ?? 70, rating: 'GOOD', ratingLabelTh: '' },
    profitability: { profitabilityScore: overrides.profitabilityScore ?? 70 },
    tradeScore: { tradeScore: 70, tradeRating: 'GOOD', tradeRatingLabelTh: '', breakdown: {} },
    entryPlan: { entry_type: 'MARKET_NOW', pending_order_type: 'NONE' },
    quote: { bid: 1.1, ask: 1.1001, currentPrice: 1.1001, spread: 0.0001 },
    protection: { stopLoss: 1.09, takeProfit: 1.12, riskReward: 2 },
    positionSizing: { maximumPlannedLoss: '10.00000000', targetProfit: '20.00000000' },
    risk: { result: 'PASS', label: '', failedRules: [] },
    explanation: { title: '', summary: 'test', bullets: [], risks: [] },
    planId: null,
  } as never;
}

describe.skipIf(SKIP)('runM5OpportunityScan', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await pool.query(`DELETE FROM shadow_trades WHERE symbol LIKE 'TESTM5SCAN%'`);
    await pool.query(`DELETE FROM opportunity_scan_results WHERE symbol LIKE 'TESTM5SCAN%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTM5SCAN%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTM5SCAN%'`);
    await pool.query(`DELETE FROM instruments WHERE symbol LIKE 'TESTM5SCAN%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertInstrument(symbol: string, assetClass = 'FOREX') {
    await pool.query(
      `INSERT INTO instruments(symbol, broker_symbol, asset_class) VALUES($1,$1,$2)
       ON CONFLICT (symbol) DO UPDATE SET asset_class = EXCLUDED.asset_class`,
      [symbol, assetClass],
    );
  }

  it('caps the AI stage to M5_AI_SHORTLIST_SIZE, never one call per discovered instrument', async () => {
    for (let i = 0; i < 5; i += 1) await insertInstrument(`TESTM5SCANBOUND${i}`);
    const fixtures: Record<string, SymbolFixture> = {};
    for (let i = 0; i < 5; i += 1) fixtures[`TESTM5SCANBOUND${i}`] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION' }));
    process.env.M5_AI_SHORTLIST_SIZE = '2';
    try {
      const result = await runM5OpportunityScan(pool, ACTOR, new Date().toISOString());
      expect(result.summary.dataValid).toBe(5);
      expect(result.summary.aiShortlisted).toBe(2);
      expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.M5_AI_SHORTLIST_SIZE;
    }
  });

  it('tags every AI analysis run with trigger_source=M5_CYCLE and the candle timestamp', async () => {
    await insertInstrument('TESTM5SCANTAG');
    setupMt5Mocks({ TESTM5SCANTAG: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (poolArg, symbol, actor, options) => {
      // Persist a real ai_analysis_runs row the way the real (unmocked)
      // analyzeSymbolWithAI would, using the triggerSource/m5CandleTimestamp
      // this scan is required to pass through.
      await poolArg.query(
        `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source, m5_candle_timestamp)
         VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','NO_EXECUTION',$2,$3)`,
        [symbol, options?.triggerSource ?? 'MANUAL', options?.m5CandleTimestamp ?? null],
      );
      return cannedDetail({ action: 'NO_EXECUTION' });
    });
    const candleTs = new Date().toISOString();
    await runM5OpportunityScan(pool, ACTOR, candleTs);
    const saved = await pool.query(`SELECT trigger_source, m5_candle_timestamp FROM ai_analysis_runs WHERE symbol='TESTM5SCANTAG'`);
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].trigger_source).toBe('M5_CYCLE');
    expect(new Date(saved.rows[0].m5_candle_timestamp).toISOString()).toBe(candleTs);
  });

  it('the M5-keyed reuse cache prevents a duplicate OpenAI call for the same symbol + M5 candle', async () => {
    await insertInstrument('TESTM5SCANREUSE');
    setupMt5Mocks({ TESTM5SCANREUSE: { bars: TRENDING_BARS } });
    const m5LastClosedTime = new Date((TRENDING_BARS[TRENDING_BARS.length - 1].time as number) * 1000).toISOString();

    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason, trigger_source)
       VALUES('TESTM5SCANREUSE','FOREX','openai','gpt-test','TEST_PROMPT',$1,'BUY',70,70,88,'ENTER_NOW','MARKET_ENTRY_READY','M5_CYCLE') RETURNING id`,
      [JSON.stringify({ timeframes: [{ timeframe: 'M5', lastClosedTime: m5LastClosedTime }] })],
    );
    await pool.query(
      `INSERT INTO ai_trade_plans(
         analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision,
         confidence_pct, tradeability_pct, tradeability_rating, profitability_score,
         entry_type, pending_order_type, current_price, entry_price, stop_loss, take_profit, risk_reward,
         max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
       VALUES($1,'TESTM5SCANREUSE','FOREX','openai','gpt-test','TEST_PROMPT','BUY',
         70,70,'GOOD',88,
         'MARKET_NOW','NONE',1.1,1.1,1.09,1.12,2,
         '1.48000000','3.22000000', now() + interval '30 minutes', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')`,
      [runRow.rows[0].id],
    );

    const result = await runM5OpportunityScan(pool, ACTOR, m5LastClosedTime);
    expect(analyzeSymbolWithAI).not.toHaveBeenCalled();
    expect(result.summary.reusedFromCache).toBe(1);
    expect(result.summary.openAiRequestsUsed).toBe(0);
  });

  it('creates a shadow trade for every actionable row from the cycle', async () => {
    await insertInstrument('TESTM5SCANSHADOW');
    setupMt5Mocks({ TESTM5SCANSHADOW: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (poolArg, symbol) => {
      const runRow = await poolArg.query(
        `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
         VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','M5_CYCLE') RETURNING id`,
        [symbol],
      );
      const planRow = await poolArg.query(
        `INSERT INTO ai_trade_plans(analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, entry_type, pending_order_type,
           entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
         VALUES($1,$2,'FOREX','openai','gpt-test','TEST','BUY','MARKET_NOW','NONE',
           1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '30 minutes', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')
         RETURNING id`,
        [runRow.rows[0].id, symbol],
      );
      const detail = cannedDetail({ action: 'ENTER_NOW' }) as Record<string, unknown>;
      detail.planId = planRow.rows[0].id;
      return detail as never;
    });

    const result = await runM5OpportunityScan(pool, ACTOR, new Date().toISOString());
    expect(result.summary.shadowTradesCreated).toBe(1);
    const shadow = await pool.query(`SELECT * FROM shadow_trades WHERE symbol='TESTM5SCANSHADOW'`);
    expect(shadow.rows).toHaveLength(1);
    expect(shadow.rows[0].status).toBe('ENTERED');
  });

  it('never calls order_send/pending-order execution from the M5 cycle path', async () => {
    await insertInstrument('TESTM5SCANNOORDER');
    setupMt5Mocks({ TESTM5SCANNOORDER: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION' }));
    await runM5OpportunityScan(pool, ACTOR, new Date().toISOString());
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
  });

  // Spec section 30: given several qualifying (Risk-PASS, broker-validated)
  // candidates, only the TOP REAL_DEMO_TOP_CANDIDATES by final_quality_score
  // become REAL DEMO eligible — the rest stay SHADOW LEARNING ONLY with a
  // reason naming the filled capacity, never simply "score too low".
  it('selects only the TOP N REAL DEMO candidates by final_quality_score; the rest become SHADOW LEARNING ONLY', async () => {
    const symbols = ['TESTM5SCANTOPHI', 'TESTM5SCANTOPMED', 'TESTM5SCANTOPLOW'];
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);

    const scoresBySymbol: Record<string, { profitabilityScore: number; tradeabilityPct: number; confidencePct: number }> = {
      TESTM5SCANTOPHI: { profitabilityScore: 95, tradeabilityPct: 95, confidencePct: 90 },
      TESTM5SCANTOPMED: { profitabilityScore: 80, tradeabilityPct: 80, confidencePct: 75 },
      TESTM5SCANTOPLOW: { profitabilityScore: 40, tradeabilityPct: 40, confidencePct: 40 },
    };

    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (poolArg, symbol) => {
      const s = scoresBySymbol[symbol as string];
      const runRow = await poolArg.query(
        `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, action, trigger_source)
         VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,'BUY','ENTER_NOW','M5_CYCLE') RETURNING id`,
        [symbol],
      );
      const planRow = await poolArg.query(
        `INSERT INTO ai_trade_plans(analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision, confidence_pct, tradeability_pct, profitability_score, entry_type, pending_order_type,
           entry_price, stop_loss, take_profit, risk_reward, max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
         VALUES($1,$2,'FOREX','openai','gpt-test','TEST','BUY',$3,$4,$5,'MARKET_NOW','NONE',
           1.1,1.09,1.12,2,'10.00000000','20.00000000', now() + interval '30 minutes', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')
         RETURNING id`,
        [runRow.rows[0].id, symbol, s.confidencePct, s.tradeabilityPct, s.profitabilityScore],
      );
      const detail = cannedDetail({ action: 'ENTER_NOW', profitabilityScore: s.profitabilityScore, tradeabilityPct: s.tradeabilityPct, confidencePct: s.confidencePct }) as Record<string, unknown>;
      detail.planId = planRow.rows[0].id;
      return detail as never;
    });

    process.env.REAL_DEMO_TOP_CANDIDATES = '2';
    process.env.REAL_DEMO_MIN_FINAL_SCORE = '0';
    try {
      const result = await runM5OpportunityScan(pool, ACTOR, new Date().toISOString());
      expect(result.summary.realDemoEligible).toBe(2);
      expect(result.summary.shadowLearningOnly).toBe(1);
      expect(result.realDemoCandidates.map((r) => r.symbol)).toEqual(['TESTM5SCANTOPHI', 'TESTM5SCANTOPMED']);
      const lowRow = result.shadowLearningOnly.find((r) => r.symbol === 'TESTM5SCANTOPLOW');
      expect(lowRow?.realDemoEligible).toBe(false);
      expect(lowRow?.shadowOnlyReason).toMatch(/TOP 2 REAL DEMO slots already filled/);
    } finally {
      delete process.env.REAL_DEMO_TOP_CANDIDATES;
      delete process.env.REAL_DEMO_MIN_FINAL_SCORE;
    }
  });

});
