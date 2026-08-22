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

import { AiPlanValidationError, AiProviderRateLimitError } from '../services/trading-ai/types';
import * as mt5Client from '../services/mt5-client';
import { analyzeSymbolWithAI, runBrokerPreflight } from '../services/trading-ai/trading-ai-service';
import { rankByTradeability, runOpportunityScan, ScanResultRow } from '../services/trading-ai/opportunity-scan';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

function row(overrides: Partial<ScanResultRow> = {}): ScanResultRow {
  return {
    symbol: 'TEST', assetClass: 'FOREX', decision: 'BUY', action: 'WAIT_FOR_ENTRY', actionReason: 'PENDING_ENTRY_PLAN_READY', confidencePct: 70,
    tradeabilityPct: 50, tradeabilityRating: 'FAIR', tradeabilityRatingLabelTh: 'ปานกลาง', profitabilityScore: 50,
    tradeScore: 50, tradeRating: 'FAIR', tradeRatingLabelTh: 'พอเทรดได้',
    entryType: 'MARKET_NOW', pendingOrderType: 'NONE', currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null,
    planExpiry: null, planId: null, riskResult: 'PASS', riskFailedRules: null, riskReward: null,
    maxLoss: null, targetProfit: null, marginRequired: null, freeMargin: null, marginShortfall: null,
    aiProvider: null, aiModel: null, aiPromptVersion: null,
    reasonSummary: null, error: null, reused: false, shadowTradeActive: false, shadowTradeStatus: null,
    side: 'BUY', recommendedVolume: null, demoExecutionReady: true, blockReasons: [], brokerPreflightPass: true, executableNow: true,
    technicalValid: true, technicalBlockCode: null, technicalBlockMessage: null,
    ...overrides,
  };
}

describe('Opportunity scan ranking', () => {
  it('ranks strictly by tradeability_pct, not by AI confidence', () => {
    const rows = [
      row({ symbol: 'A', tradeabilityPct: 60, confidencePct: 95 }),
      row({ symbol: 'B', tradeabilityPct: 84, confidencePct: 55 }),
      row({ symbol: 'C', tradeabilityPct: 76, confidencePct: 70 }),
    ];
    const ranked = rankByTradeability(rows);
    expect(ranked.map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
  });

  it('never discards a low-tradeability row — it sorts to the bottom but stays present', () => {
    const rows = [
      row({ symbol: 'LOW', tradeabilityPct: 12 }),
      row({ symbol: 'HIGH', tradeabilityPct: 92 }),
    ];
    const ranked = rankByTradeability(rows);
    expect(ranked.map((r) => r.symbol)).toEqual(['HIGH', 'LOW']);
    expect(ranked).toHaveLength(2);
  });

  it('sorts rows with no tradeability_pct (errors) to the bottom', () => {
    const rows = [
      row({ symbol: 'NOSCORE', tradeabilityPct: null }),
      row({ symbol: 'SCORED', tradeabilityPct: 40 }),
    ];
    const ranked = rankByTradeability(rows);
    expect(ranked.map((r) => r.symbol)).toEqual(['SCORED', 'NOSCORE']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ symbol: 'A', tradeabilityPct: 10 }), row({ symbol: 'B', tradeabilityPct: 90 })];
    const ranked = rankByTradeability(rows);
    expect(rows.map((r) => r.symbol)).toEqual(['A', 'B']);
    expect(ranked.map((r) => r.symbol)).toEqual(['B', 'A']);
  });
});

// ---------------------------------------------------------------------------
// Two-stage scanner (spec sections 2-16): STAGE A (MT5-only, free) filters
// and shortlists real, catalog-synced instruments; STAGE B (analyzeSymbolWithAI,
// paid) only ever runs on the bounded shortlist. Every test below drives the
// real runOpportunityScan() against a real test-database `instruments` table
// (never a watchlist) with a fully mocked MT5 client and a fully mocked
// Trading AI, so the pre-filter/shortlist/ranking/actionable-filtering logic
// itself is what's under test — never a live MT5 terminal or OpenAI call.
// ---------------------------------------------------------------------------

const ACTOR: Mt5Actor = { actorId: null, actorEmail: 'test@internal', requestId: 'test' };

// A realistic oscillating uptrend (drift + a sine wave), not a perfectly
// monotonic line — a pure monotonic series pins RSI at exactly 100 (an
// "overbought extreme", not a healthy trend) and produces zero fractal
// pivot points, both unrealistic edge cases that would defeat the point of
// the shortlist heuristic's momentum/structure components.
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
    bars.push({ time: nowSeconds - (count - i) * 3600, open, high, low, close, tick_volume: 100 });
  }
  return bars;
}

const TRENDING_BARS = makeBars(220, 1.1000, 0.0004, 0.0008); // real uptrend with light oscillation -> BULLISH H1/H4
const FLAT_BARS = makeBars(220, 1.1000, 0, 0.0008); // oscillates around a flat mean -> RANGE/UNCLEAR
const INSUFFICIENT_BARS = makeBars(10, 1.1000, 0.0004, 0.0008); // below MIN_BARS_REQUIRED

interface SymbolFixture {
  marketStatus?: string;
  dataStatus?: string;
  symbolInfoUnavailable?: boolean;
  tradeMode?: number;
  tick?: { bid: number; ask: number; time: number } | 'unavailable';
  bars?: Record<string, unknown>[];
}

function setupMt5Mocks(fixtures: Record<string, SymbolFixture>) {
  // Realistic non-zero equity/margin AND full broker symbol economics (spec
  // section 6 risk-freshness fix means a reused plan's risk is now really
  // recomputed via evaluateMt5Risk/toRiskSymbolInfo for every scan, not just
  // read back from a stale DB column) — an empty account/incomplete
  // symbol_info would make every reused-plan risk check REJECT with
  // SYMBOL_INFO_UNAVAILABLE regardless of what the test intends to exercise.
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue({
    connected: true, demo_verified: true,
    account: { equity: '10000', balance: '10000', margin_free: '9000', free_margin: '9000', leverage: 500 },
    terminal: {},
  } as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
  // Default: the "TOP 10 EXECUTABLE" broker preflight passes unless a test
  // overrides it (vi.mocked(runBrokerPreflight).mockResolvedValueOnce(...))
  // to exercise a specific preflight-failure case.
  vi.mocked(runBrokerPreflight).mockResolvedValue({ brokerPreflightPass: true, reason: null });

  vi.mocked(mt5Client.getMt5MarketStatus).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    if (!f) return { market_status: 'CLOSED', data_status: 'DISCONNECTED' } as never; // unknown/stray symbol -> never eligible
    return { market_status: f.marketStatus ?? 'OPEN', data_status: f.dataStatus ?? 'LIVE' } as never;
  });

  vi.mocked(mt5Client.getMt5SymbolInfo).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    if (!f || f.symbolInfoUnavailable) throw new Error('symbol_info unavailable');
    return {
      point: 0.00001, digits: 5, trade_mode: f.tradeMode ?? 4,
      trade_contract_size: 100000, trade_tick_size: 0.00001, trade_tick_value: 1,
      volume_min: 0.01, volume_max: 100, volume_step: 0.01,
    } as never;
  });

  vi.mocked(mt5Client.getMt5Tick).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    if (!f || f.tick === 'unavailable') throw new Error('tick unavailable');
    const tick = f.tick ?? { bid: 1.1, ask: 1.1001, time: Math.floor(Date.now() / 1000) };
    return tick as never;
  });

  vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    return (f?.bars ?? []) as never;
  });
}

function cannedDetail(overrides: {
  direction?: 'BUY' | 'SELL' | 'WAIT';
  action: string;
  actionReason?: string;
  tradeabilityPct?: number | null;
  profitabilityScore?: number | null;
  tradeScore?: number | null;
  confidencePct?: number;
  riskResult?: 'PASS' | 'REJECT' | null;
  riskFailedRules?: string[];
  entryType?: string;
  pendingOrderType?: string;
  riskReward?: number | null;
  maxLoss?: string | null;
  targetProfit?: string | null;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  recommendedVolume?: string | null;
}) {
  const tradeabilityPct = overrides.tradeabilityPct === undefined ? 70 : overrides.tradeabilityPct;
  const profitabilityScore = overrides.profitabilityScore === undefined ? 70 : overrides.profitabilityScore;
  return {
    aiConfigured: true,
    decision: { direction: overrides.direction ?? 'BUY', confidencePct: overrides.confidencePct ?? 70, trend: 'BULLISH', marketCondition: 'trending' },
    action: { action: overrides.action, reason: overrides.actionReason ?? 'TEST', orderIntent: null },
    tradeability: tradeabilityPct === null ? null : { tradeabilityPct, rating: 'GOOD', ratingLabelTh: 'น่าเทรด' },
    profitability: profitabilityScore === null ? null : { profitabilityScore },
    tradeScore: overrides.tradeScore === undefined ? { tradeScore: 70, tradeRating: 'GOOD', tradeRatingLabelTh: 'น่าเทรด', breakdown: {} } : (overrides.tradeScore === null ? null : { tradeScore: overrides.tradeScore, tradeRating: 'GOOD', tradeRatingLabelTh: 'น่าเทรด', breakdown: {} }),
    entryPlan: { entry_type: overrides.entryType ?? 'MARKET_NOW', pending_order_type: overrides.pendingOrderType ?? 'NONE', entry_price: overrides.entryPrice ?? null },
    quote: { bid: null, ask: null, currentPrice: null, spread: null },
    protection: { stopLoss: overrides.stopLoss ?? null, takeProfit: overrides.takeProfit ?? null, riskReward: overrides.riskReward ?? 2 },
    positionSizing: { maximumPlannedLoss: overrides.maxLoss ?? null, targetProfit: overrides.targetProfit ?? null, recommendedLotSize: overrides.recommendedVolume ?? '0.10000000' },
    risk: { result: overrides.riskResult === undefined ? 'PASS' : overrides.riskResult, label: '', failedRules: overrides.riskFailedRules ?? [] },
    explanation: { title: '', summary: 'test summary', bullets: [], risks: [] },
    planId: null,
  } as never;
}

describe.skipIf(SKIP)('runOpportunityScan (two-stage scanner)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await pool.query(`DELETE FROM opportunity_scan_results WHERE symbol LIKE 'TESTSCAN%'`);
    // shadow_trades.ai_trade_plan_id REFERENCES ai_trade_plans(id) with no
    // CASCADE (spec: shadow trades are now also created from the manual
    // scan, not only the M5 cycle) — must be deleted first or the
    // ai_trade_plans delete below violates the FK constraint.
    await pool.query(`DELETE FROM shadow_trades WHERE symbol LIKE 'TESTSCAN%'`);
    await pool.query(`DELETE FROM ai_trade_plans WHERE symbol LIKE 'TESTSCAN%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTSCAN%'`);
    await pool.query(`DELETE FROM instruments WHERE symbol LIKE 'TESTSCAN%'`);
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

  it('filters out a symbol whose symbol_info is unavailable', async () => {
    await insertInstrument('TESTSCANNOINFO');
    setupMt5Mocks({ TESTSCANNOINFO: { symbolInfoUnavailable: true, bars: TRENDING_BARS } });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.dataValid).toBe(0);
    expect(result.dataRejected.find((c) => c.symbol === 'TESTSCANNOINFO')?.reason).toMatch(/symbol_info/i);
    expect(analyzeSymbolWithAI).not.toHaveBeenCalled();
  });

  it('filters out a symbol with an invalid (crossed) quote', async () => {
    await insertInstrument('TESTSCANBADQUOTE');
    setupMt5Mocks({ TESTSCANBADQUOTE: { tick: { bid: 1.2, ask: 1.1, time: Math.floor(Date.now() / 1000) }, bars: TRENDING_BARS } });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.dataValid).toBe(0);
    expect(result.dataRejected.find((c) => c.symbol === 'TESTSCANBADQUOTE')?.reason).toMatch(/quote/i);
  });

  it('filters out a symbol with a stale quote', async () => {
    await insertInstrument('TESTSCANSTALE');
    setupMt5Mocks({ TESTSCANSTALE: { tick: { bid: 1.1, ask: 1.1001, time: Math.floor(Date.now() / 1000) - 600 }, bars: TRENDING_BARS } });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.dataValid).toBe(0);
    expect(result.dataRejected.find((c) => c.symbol === 'TESTSCANSTALE')?.reason).toMatch(/stale/i);
  });

  it('filters out a symbol with insufficient timeframe candle data', async () => {
    await insertInstrument('TESTSCANBADBARS');
    setupMt5Mocks({ TESTSCANBADBARS: { bars: INSUFFICIENT_BARS } });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.dataValid).toBe(0);
    expect(result.dataRejected.find((c) => c.symbol === 'TESTSCANBADBARS')?.reason).toMatch(/candle data/i);
  });

  it('filters out a symbol whose market/session status is not OPEN+LIVE', async () => {
    await insertInstrument('TESTSCANCLOSED');
    setupMt5Mocks({ TESTSCANCLOSED: { marketStatus: 'CLOSED', bars: TRENDING_BARS } });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.dataValid).toBe(0);
  });

  it('respects the shortlist size limit — never sends every data-valid symbol to the AI', async () => {
    await insertInstrument('TESTSCANA');
    await insertInstrument('TESTSCANB');
    await insertInstrument('TESTSCANC');
    setupMt5Mocks({
      TESTSCANA: { bars: TRENDING_BARS },
      TESTSCANB: { bars: TRENDING_BARS },
      TESTSCANC: { bars: TRENDING_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION' }));
    const result = await runOpportunityScan(pool, ACTOR, 2);
    expect(result.summary.dataValid).toBe(3);
    expect(result.summary.aiShortlisted).toBe(2);
    expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(2);
  });

  it('prefers a strongly-trending symbol over a flat one for the shortlist', async () => {
    await insertInstrument('TESTSCANTREND');
    await insertInstrument('TESTSCANFLAT');
    setupMt5Mocks({
      TESTSCANTREND: { bars: TRENDING_BARS },
      TESTSCANFLAT: { bars: FLAT_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION' }));
    await runOpportunityScan(pool, ACTOR, 1);
    expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeSymbolWithAI).mock.calls[0][1]).toBe('TESTSCANTREND');
  });

  it('includes ENTER_NOW in the primary actionable results', async () => {
    await insertInstrument('TESTSCANENTER');
    setupMt5Mocks({ TESTSCANENTER: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', tradeabilityPct: 88 }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.actionable.map((r) => r.symbol)).toContain('TESTSCANENTER');
    expect(result.summary.enterNow).toBe(1);
  });

  it('includes WAIT_FOR_ENTRY in the primary actionable results', async () => {
    await insertInstrument('TESTSCANWAIT');
    setupMt5Mocks({ TESTSCANWAIT: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'WAIT_FOR_ENTRY', tradeabilityPct: 81, entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT' }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.actionable.map((r) => r.symbol)).toContain('TESTSCANWAIT');
    expect(result.summary.waitForEntry).toBe(1);
  });

  it('includes a LOW-tradeability actionable setup — never discards a valid plan for low quality', async () => {
    await insertInstrument('TESTSCANLOWQUALITY');
    setupMt5Mocks({ TESTSCANLOWQUALITY: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', tradeabilityPct: 12 }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const found = result.actionable.find((r) => r.symbol === 'TESTSCANLOWQUALITY');
    expect(found).toBeDefined();
    expect(found?.tradeabilityPct).toBe(12);
  });

  it('excludes NO_EXECUTION (genuine technical impossibility) from the primary actionable results', async () => {
    await insertInstrument('TESTSCANNOEXEC');
    setupMt5Mocks({ TESTSCANNOEXEC: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION', tradeabilityPct: null, tradeScore: null, direction: 'WAIT' }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.actionable.find((r) => r.symbol === 'TESTSCANNOEXEC')).toBeUndefined();
    expect(result.rejected.map((r) => r.symbol)).toContain('TESTSCANNOEXEC');
    expect(result.summary.technicalBlocked).toBe(1);
  });

  it('marks a Risk-Engine-blocked setup correctly in the summary while still keeping it in actionable', async () => {
    await insertInstrument('TESTSCANRISKBLOCKED');
    setupMt5Mocks({ TESTSCANRISKBLOCKED: { bars: TRENDING_BARS } });
    // Risk Engine result is fully independent of `action` (spec section 8) —
    // a REJECT never downgrades ENTER_NOW/WAIT_FOR_ENTRY anymore.
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', riskResult: 'REJECT' }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.actionable.find((r) => r.symbol === 'TESTSCANRISKBLOCKED')).toBeDefined();
    expect(result.summary.riskBlocked).toBe(1);
  });

  it('ranks multiple actionable candidates by profitability_score, not tradeability_pct', async () => {
    await insertInstrument('TESTSCANHIGH');
    await insertInstrument('TESTSCANLOW');
    setupMt5Mocks({
      TESTSCANHIGH: { bars: TRENDING_BARS },
      TESTSCANLOW: { bars: FLAT_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      // Deliberately inverted tradeability_pct vs profitability_score so a
      // tradeability-based ranking (the old behavior) would produce the
      // OPPOSITE order — proves the TOP-list ranking is truly primary-sorted
      // by profitability_score, not silently still using tradeability.
      if (symbol === 'TESTSCANHIGH') return cannedDetail({ action: 'ENTER_NOW', tradeabilityPct: 40, profitabilityScore: 90 });
      return cannedDetail({ action: 'ENTER_NOW', tradeabilityPct: 95, profitabilityScore: 61 });
    });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const symbols = result.actionable.filter((r) => r.symbol === 'TESTSCANHIGH' || r.symbol === 'TESTSCANLOW').map((r) => r.symbol);
    expect(symbols).toEqual(['TESTSCANHIGH', 'TESTSCANLOW']);
  });

  it('breaks a profitability_score tie using tradeability_pct', async () => {
    await insertInstrument('TESTSCANTIEHIGH');
    await insertInstrument('TESTSCANTIELOW');
    setupMt5Mocks({
      TESTSCANTIEHIGH: { bars: TRENDING_BARS },
      TESTSCANTIELOW: { bars: FLAT_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      if (symbol === 'TESTSCANTIEHIGH') return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 70, tradeabilityPct: 90 });
      return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 70, tradeabilityPct: 61 });
    });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const symbols = result.actionable.filter((r) => r.symbol === 'TESTSCANTIEHIGH' || r.symbol === 'TESTSCANTIELOW').map((r) => r.symbol);
    expect(symbols).toEqual(['TESTSCANTIEHIGH', 'TESTSCANTIELOW']);
  });

  it('ranks 95/88/81/75/70 profitability_score rows in descending order without discarding any', async () => {
    const scores = [95, 88, 81, 75, 70];
    const symbols = scores.map((_, i) => `TESTSCANRANK${i}`);
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      const idx = symbols.indexOf(symbol);
      return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: scores[idx] });
    });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const ranked = result.actionable.filter((r) => symbols.includes(r.symbol)).map((r) => r.profitabilityScore);
    expect(ranked).toEqual([95, 88, 81, 75, 70]);
  });

  it('never ranks by raw dollar target_profit — a bigger max_loss/target_profit never outranks a higher profitability_score', async () => {
    await insertInstrument('TESTSCANBIGDOLLAR');
    await insertInstrument('TESTSCANSMALLDOLLAR');
    setupMt5Mocks({
      TESTSCANBIGDOLLAR: { bars: TRENDING_BARS },
      TESTSCANSMALLDOLLAR: { bars: FLAT_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      if (symbol === 'TESTSCANBIGDOLLAR') {
        return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 55, maxLoss: '500.00000000', targetProfit: '1200.00000000' });
      }
      return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 82, maxLoss: '1.48000000', targetProfit: '3.22000000' });
    });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const symbols = result.actionable.filter((r) => r.symbol === 'TESTSCANBIGDOLLAR' || r.symbol === 'TESTSCANSMALLDOLLAR').map((r) => r.symbol);
    // The huge-dollar-value row has the LOWER profitability_score, so it
    // must rank second despite its far larger max_loss/target_profit.
    expect(symbols).toEqual(['TESTSCANSMALLDOLLAR', 'TESTSCANBIGDOLLAR']);
  });

  it('reports zero actionable results honestly when everything is NO_EXECUTION — never invents a trade', async () => {
    await insertInstrument('TESTSCANNONE1');
    await insertInstrument('TESTSCANNONE2');
    setupMt5Mocks({
      TESTSCANNONE1: { bars: TRENDING_BARS },
      TESTSCANNONE2: { bars: TRENDING_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION', tradeabilityPct: null, tradeScore: null, direction: 'WAIT' }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.actionable).toHaveLength(0);
    expect(result.summary.actionable).toBe(0);
    expect(result.summary.technicalBlocked).toBe(2);
  });

  it('bounds the number of AI calls to the shortlist size, never one per discovered instrument', async () => {
    for (let i = 0; i < 6; i += 1) await insertInstrument(`TESTSCANBOUND${i}`);
    const fixtures: Record<string, SymbolFixture> = {};
    for (let i = 0; i < 6; i += 1) fixtures[`TESTSCANBOUND${i}`] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'NO_EXECUTION' }));
    const result = await runOpportunityScan(pool, ACTOR, 3);
    expect(result.summary.dataValid).toBe(6);
    expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(3);
  });

  it('never calls order_send/pending-order execution from the scan path', async () => {
    await insertInstrument('TESTSCANNOORDER');
    setupMt5Mocks({ TESTSCANNOORDER: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', tradeabilityPct: 90 }));
    await runOpportunityScan(pool, ACTOR, 5);
    expect(mt5Client.sendMt5Order).not.toHaveBeenCalled();
    expect(mt5Client.sendMt5PendingOrder).not.toHaveBeenCalled();
  });

  // "TOP 10 EXECUTABLE BUY LIMIT" fix — a BUY_LIMIT row with a PASS risk
  // result and a passing broker preflight (default mock) is genuinely
  // executable now and belongs in the ranked list (spec test case 1).
  function executableBuyLimitDetail(overrides: { profitabilityScore?: number; actionReason?: string } = {}) {
    return cannedDetail({
      action: 'WAIT_FOR_ENTRY', actionReason: overrides.actionReason ?? 'PENDING_ENTRY_PLAN_READY',
      entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
      profitabilityScore: overrides.profitabilityScore ?? 70, riskResult: 'PASS',
    });
  }

  it('spec case 1: BUY LIMIT + risk pass + margin ok + broker preflight ok -> included in Top 10', async () => {
    await insertInstrument('TESTSCANOK');
    setupMt5Mocks({ TESTSCANOK: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(executableBuyLimitDetail());
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const found = result.topOpportunities.find((r) => r.symbol === 'TESTSCANOK');
    expect(found).toBeDefined();
    expect(found?.executableNow).toBe(true);
    expect(found?.pendingOrderType).toBe('BUY_LIMIT');
    expect(result.summary.executableBuyLimitFound).toBe(1);
  });

  it('spec case 2: BUY LIMIT + risk blocked -> excluded from Top 10 (moved to otherIdeas)', async () => {
    await insertInstrument('TESTSCANBLOCKEDBL');
    setupMt5Mocks({ TESTSCANBLOCKEDBL: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, profitabilityScore: 90,
      riskResult: 'REJECT', riskFailedRules: ['MAX_SIMULTANEOUS_POSITIONS'],
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANBLOCKEDBL')).toBeUndefined();
    const other = result.otherIdeas.find((r) => r.symbol === 'TESTSCANBLOCKEDBL');
    expect(other).toBeDefined();
    expect(other?.executableNow).toBe(false);
    expect(other?.blockReasons).toContain('MAX_SIMULTANEOUS_POSITIONS');
    expect(result.actionable.find((r) => r.symbol === 'TESTSCANBLOCKEDBL')).toBeDefined();
  });

  it('spec case 3: SELL LIMIT even if executable -> excluded from Top 10 for now (BUY-LIMIT-ONLY MODE)', async () => {
    await insertInstrument('TESTSCANSELLLIMIT');
    setupMt5Mocks({ TESTSCANSELLLIMIT: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      direction: 'SELL', action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'SELL_LIMIT',
      entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08, profitabilityScore: 95, riskResult: 'PASS',
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANSELLLIMIT')).toBeUndefined();
    const other = result.otherIdeas.find((r) => r.symbol === 'TESTSCANSELLLIMIT');
    // Genuinely executable (risk PASS, preflight PASS) — just not BUY_LIMIT.
    expect(other?.executableNow).toBe(true);
    expect(other?.pendingOrderType).toBe('SELL_LIMIT');
  });

  it('spec case 4: BUY LIMIT + broker retcode zero / pending_order_not_confirmed -> excluded from Top 10', async () => {
    await insertInstrument('TESTSCANRETCODEZERO');
    setupMt5Mocks({ TESTSCANRETCODEZERO: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(executableBuyLimitDetail({ profitabilityScore: 92 }));
    vi.mocked(runBrokerPreflight).mockResolvedValueOnce({ brokerPreflightPass: false, reason: 'MT5_RETCODE_0' });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANRETCODEZERO')).toBeUndefined();
    const other = result.otherIdeas.find((r) => r.symbol === 'TESTSCANRETCODEZERO');
    expect(other?.brokerPreflightPass).toBe(false);
    expect(other?.executableNow).toBe(false);
    expect(other?.blockReasons).toContain('MT5_RETCODE_0');
  });

  it('spec case 5: BUY LIMIT + position exists -> excluded', async () => {
    await insertInstrument('TESTSCANPOSEXISTS');
    setupMt5Mocks({ TESTSCANPOSEXISTS: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, profitabilityScore: 90,
      riskResult: 'REJECT', riskFailedRules: ['POSITION_EXISTS'],
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANPOSEXISTS')).toBeUndefined();
    expect(result.otherIdeas.find((r) => r.symbol === 'TESTSCANPOSEXISTS')?.blockReasons).toContain('POSITION_EXISTS');
  });

  it('spec case 6: BUY LIMIT + min volume exceeds risk -> excluded', async () => {
    await insertInstrument('TESTSCANMINVOL');
    setupMt5Mocks({ TESTSCANMINVOL: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, profitabilityScore: 90,
      riskResult: 'REJECT', riskFailedRules: ['MINIMUM_VOLUME_EXCEEDS_RISK'],
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANMINVOL')).toBeUndefined();
    expect(result.otherIdeas.find((r) => r.symbol === 'TESTSCANMINVOL')?.blockReasons).toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
  });

  it('spec case 7: BUY LIMIT + stale/invalid quote -> excluded', async () => {
    await insertInstrument('TESTSCANSTALEQ');
    setupMt5Mocks({ TESTSCANSTALEQ: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, profitabilityScore: 90,
      riskResult: 'REJECT', riskFailedRules: ['STALE_QUOTE'],
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANSTALEQ')).toBeUndefined();
    expect(result.otherIdeas.find((r) => r.symbol === 'TESTSCANSTALEQ')?.blockReasons).toContain('STALE_QUOTE');
  });

  it('spec case 8: more than 10 executable BUY LIMIT rows -> sorted by aiProfitability desc, only 10 returned', async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => `TESTSCANTOP${i}`);
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      const idx = symbols.indexOf(symbol);
      // Descending distinct scores: 99, 98, ... so the ranking order is unambiguous.
      return executableBuyLimitDetail({ profitabilityScore: 99 - idx });
    });
    const result = await runOpportunityScan(pool, ACTOR, 12);
    const own = result.topOpportunities.filter((r) => symbols.includes(r.symbol));
    expect(own).toHaveLength(10);
    expect(own.map((r) => r.symbol)).toEqual(symbols.slice(0, 10));
    expect(result.summary.topOpportunitiesShown).toBe(10);
    expect(result.summary.executableBuyLimitFound).toBe(12);
    // The full actionable list is never truncated — only the TOP 10 view is;
    // the other 2 executable BUY_LIMIT rows land in otherIdeas.
    expect(result.actionable.filter((r) => symbols.includes(r.symbol))).toHaveLength(12);
    expect(result.otherIdeas.filter((r) => symbols.includes(r.symbol))).toHaveLength(2);
  });

  it('spec case 9: fewer than 10 executable BUY LIMIT rows -> shows only the available rows', async () => {
    const symbols = ['TESTSCANFEWBL0', 'TESTSCANFEWBL1', 'TESTSCANFEWBL2'];
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(executableBuyLimitDetail({ profitabilityScore: 70 }));
    const result = await runOpportunityScan(pool, ACTOR, 3);
    const own = result.topOpportunities.filter((r) => symbols.includes(r.symbol));
    expect(own).toHaveLength(3);
    expect(result.summary.topOpportunitiesShown).toBe(3);
  });

  it('caps topOpportunities at 10 even when AI_BEST_TRADES_TOP_COUNT/shortlist would allow more — never more than 10 cards', async () => {
    const symbols = Array.from({ length: 11 }, (_, i) => `TESTSCANHARDCAP${i}`);
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(executableBuyLimitDetail());
    const result = await runOpportunityScan(pool, ACTOR, 11);
    expect(result.topOpportunities.length).toBeLessThanOrEqual(10);
  });

  it('persists the scan ranking dataset (spec section 20) for every topOpportunities row', async () => {
    await insertInstrument('TESTSCANDATASET');
    setupMt5Mocks({ TESTSCANDATASET: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({
      action: 'WAIT_FOR_ENTRY', entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT',
      entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
      profitabilityScore: 77, tradeabilityPct: 65, confidencePct: 72, riskReward: 2.5, riskResult: 'PASS',
    }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const persisted = await pool.query(`SELECT * FROM opportunity_scan_results WHERE scan_id = $1 AND symbol = $2`, [result.scanId, 'TESTSCANDATASET']);
    expect(persisted.rows).toHaveLength(1);
    const saved = persisted.rows[0];
    expect(saved.rank).toBe(result.topOpportunities.findIndex((r) => r.symbol === 'TESTSCANDATASET') + 1);
    expect(Number(saved.profitability_score)).toBe(77);
    expect(Number(saved.tradeability_pct)).toBe(65);
    expect(Number(saved.confidence_pct)).toBe(72);
    expect(saved.direction).toBe('BUY');
    expect(saved.action).toBe('WAIT_FOR_ENTRY');
  });

  it('reuses a recent analysis on the same completed H1 candle instead of a new OpenAI call (spec section 18)', async () => {
    await insertInstrument('TESTSCANREUSE');
    setupMt5Mocks({ TESTSCANREUSE: { bars: TRENDING_BARS } });
    const h1LastClosedTime = new Date((TRENDING_BARS[TRENDING_BARS.length - 1].time as number) * 1000).toISOString();

    // Seed a prior successful analysis run + plan for the SAME symbol on the
    // SAME completed H1 candle, as if an earlier scan already analyzed it —
    // exactly the state findReusablePlan() is meant to detect.
    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason)
       VALUES('TESTSCANREUSE','FOREX','openai','gpt-test','TEST_PROMPT',$1,'BUY',70,70,88,'ENTER_NOW','MARKET_ENTRY_READY') RETURNING id`,
      [JSON.stringify({ timeframes: [{ timeframe: 'H1', lastClosedTime: h1LastClosedTime }] })],
    );
    await pool.query(
      `INSERT INTO ai_trade_plans(
         analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision,
         confidence_pct, tradeability_pct, tradeability_rating, profitability_score,
         entry_type, pending_order_type, current_price, entry_price, stop_loss, take_profit, risk_reward,
         max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status)
       VALUES($1,'TESTSCANREUSE','FOREX','openai','gpt-test','TEST_PROMPT','BUY',
         70,70,'GOOD',88,
         'MARKET_NOW','NONE',1.1,1.1,1.09,1.12,2,
         '1.48000000','3.22000000', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL')`,
      [runRow.rows[0].id],
    );

    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(analyzeSymbolWithAI).not.toHaveBeenCalled();
    expect(result.summary.openAiRequestsUsed).toBe(0);
    expect(result.summary.reusedFromCache).toBe(1);
    const reused = result.actionable.find((r) => r.symbol === 'TESTSCANREUSE');
    expect(reused).toBeDefined();
    expect(reused?.reused).toBe(true);
    // AI fields come straight from the cached row...
    expect(reused?.profitabilityScore).toBe(88);
    // ...but maxLoss/riskResult never do (spec section 6, risk precheck
    // freshness) — this is freshly recomputed from the live mocked account
    // (equity $10000, 0.5% default risk budget = $50), never the stale
    // '1.48000000' seeded above.
    expect(reused?.maxLoss).toBe('50.00000000');
  });

  it('does not reuse a stale (older than the configured window) analysis — a genuinely new OpenAI call is made', async () => {
    await insertInstrument('TESTSCANSTALEDEDUP');
    setupMt5Mocks({ TESTSCANSTALEDEDUP: { bars: TRENDING_BARS } });
    const h1LastClosedTime = new Date((TRENDING_BARS[TRENDING_BARS.length - 1].time as number) * 1000).toISOString();

    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason, created_at)
       VALUES('TESTSCANSTALEDEDUP','FOREX','openai','gpt-test','TEST_PROMPT',$1,'BUY',70,70,88,'ENTER_NOW','MARKET_ENTRY_READY', now() - interval '1000 minutes') RETURNING id`,
      [JSON.stringify({ timeframes: [{ timeframe: 'H1', lastClosedTime: h1LastClosedTime }] })],
    );
    await pool.query(
      `INSERT INTO ai_trade_plans(
         analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision,
         confidence_pct, tradeability_pct, tradeability_rating, profitability_score,
         entry_type, pending_order_type, plan_expiry, risk_result, action, action_reason, status, created_at)
       VALUES($1,'TESTSCANSTALEDEDUP','FOREX','openai','gpt-test','TEST_PROMPT','BUY',
         70,70,'GOOD',88,
         'MARKET_NOW','NONE', now() + interval '1 hour', 'PASS','ENTER_NOW','MARKET_ENTRY_READY','WAITING_FOR_APPROVAL', now() - interval '1000 minutes')`,
      [runRow.rows[0].id],
    );

    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 40 }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(1);
    expect(result.summary.reusedFromCache).toBe(0);
    expect(result.summary.openAiRequestsUsed).toBe(1);
  });

  // Root cause of "card looked ready, click failed with PENDING_ORDER_NOT_
  // CONFIRMED": findReusablePlan() picks the latest plan for a symbol/candle
  // by created_at ALONE, with no status filter — it can resurface a plan
  // that already went through approval on a PRIOR click (already
  // PENDING_ORDER_PLACED/POSITION_OPEN, or EXECUTION_FAILED from a prior
  // inconclusive order_send). Only a plan still sitting untouched in
  // WAITING_FOR_APPROVAL may ever be presented as demoExecutionReady/
  // executableNow again.
  it('excludes a reused plan that already failed execution on a prior click, even though its stored risk_result is PASS', async () => {
    await insertInstrument('TESTSCANSTALEPLAN');
    setupMt5Mocks({ TESTSCANSTALEPLAN: { bars: TRENDING_BARS } });
    const h1LastClosedTime = new Date((TRENDING_BARS[TRENDING_BARS.length - 1].time as number) * 1000).toISOString();

    const runRow = await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package, decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason)
       VALUES('TESTSCANSTALEPLAN','FOREX','openai','gpt-test','TEST_PROMPT',$1,'BUY',70,70,88,'WAIT_FOR_ENTRY','PENDING_ENTRY_PLAN_READY') RETURNING id`,
      [JSON.stringify({ timeframes: [{ timeframe: 'H1', lastClosedTime: h1LastClosedTime }] })],
    );
    await pool.query(
      `INSERT INTO ai_trade_plans(
         analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version, decision,
         confidence_pct, tradeability_pct, tradeability_rating, profitability_score,
         entry_type, pending_order_type, current_price, entry_price, stop_loss, take_profit, risk_reward,
         max_planned_loss, target_profit, plan_expiry, risk_result, action, action_reason, status, blocked_reason)
       VALUES($1,'TESTSCANSTALEPLAN','FOREX','openai','gpt-test','TEST_PROMPT','BUY',
         70,70,'GOOD',88,
         'PULLBACK','BUY_LIMIT',1.1,1.1,1.09,1.12,2,
         '1.48000000','3.22000000', now() + interval '1 hour', 'PASS','WAIT_FOR_ENTRY','PENDING_ENTRY_PLAN_READY',
         'EXECUTION_FAILED','PENDING_ORDER_NOT_CONFIRMED')`,
      [runRow.rows[0].id],
    );

    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.summary.reusedFromCache).toBe(1);
    const reused = result.actionable.find((r) => r.symbol === 'TESTSCANSTALEPLAN');
    expect(reused).toBeDefined();
    expect(reused?.reused).toBe(true);
    expect(reused?.demoExecutionReady).toBe(false);
    expect(reused?.executableNow).toBe(false);
    expect(reused?.blockReasons.some((r) => r.startsWith('PLAN_ALREADY_EXECUTION_FAILED'))).toBe(true);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANSTALEPLAN')).toBeUndefined();
    // Never a second broker preflight call for a plan that's already known
    // to be unsafe to re-present as ready.
    expect(runBrokerPreflight).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Regression fix: "FIND BEST TRADES" came back with Valid trade plans: 0,
  // Technical blocked: 20 for a real 20-symbol scan — every one of those 20
  // rows was actually an AI-provider-layer failure (OpenAI rate-limited,
  // misclassified as a billing error; see AiProviderRateLimitError's own
  // doc comment), not a genuine "no valid plan could be constructed"
  // result, but every thrown exception collapsed into one undifferentiated
  // "Technical blocked" bucket. These tests pin the fix: a provider failure
  // must never be counted as technicalBlocked, and a valid AI plan of any
  // order type (not just BUY_LIMIT) must never be technically blocked
  // either — see decision-policy.ts and ai-failure-classification.ts.
  // ---------------------------------------------------------------------
  describe('technical validation diagnostics (regression fix)', () => {
    it('an AI-provider-layer failure (e.g. rate-limited) is counted as aiProviderErrors, never as technicalBlocked', async () => {
      await insertInstrument('TESTSCANRATELIMIT');
      setupMt5Mocks({ TESTSCANRATELIMIT: { bars: TRENDING_BARS } });
      vi.mocked(analyzeSymbolWithAI).mockRejectedValue(new AiProviderRateLimitError('OPENAI API RATE LIMITED after 3 attempts: Rate limit reached for requests'));

      const result = await runOpportunityScan(pool, ACTOR, 5);

      expect(result.summary.technicalBlocked).toBe(0);
      expect(result.summary.aiProviderErrors).toBe(1);
      expect(result.summary.aiProviderErrorBreakdown).toEqual({ AI_PROVIDER_RATE_LIMITED: 1 });
      expect(result.rejected).toHaveLength(0);
      expect(result.aiErrors).toHaveLength(1);
      expect(result.aiErrors[0].technicalBlockCode).toBe('AI_PROVIDER_RATE_LIMITED');
      expect(result.aiErrors[0].technicalValid).toBe(false);
    });

    it('a genuine schema validation failure is counted as technicalBlocked with its exact code, never as an AI provider error', async () => {
      await insertInstrument('TESTSCANSCHEMAFAIL');
      setupMt5Mocks({ TESTSCANSCHEMAFAIL: { bars: TRENDING_BARS } });
      vi.mocked(analyzeSymbolWithAI).mockRejectedValue(new AiPlanValidationError('AI response failed strict schema validation', ['stop_loss: stop_loss is required for BUY/SELL']));

      const result = await runOpportunityScan(pool, ACTOR, 5);

      expect(result.summary.technicalBlocked).toBe(1);
      expect(result.summary.aiProviderErrors).toBe(0);
      expect(result.summary.technicalBlockBreakdown).toEqual({ SCHEMA_VALIDATION_FAILED: 1 });
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].technicalBlockCode).toBe('SCHEMA_VALIDATION_FAILED');
      expect(result.rejected[0].technicalBlockMessage).toContain('stop_loss is required');
    });

    it('20 valid mixed-order-type mocked AI plans produce a valid trade plan count > 0, with zero technically blocked, and non-BUY-LIMIT plans stay valid (never misclassified)', async () => {
      const buyLimitSymbols = Array.from({ length: 5 }, (_, i) => `TESTSCANMIXBL${i}`);
      const sellLimitSymbols = Array.from({ length: 5 }, (_, i) => `TESTSCANMIXSL${i}`);
      const buyStopSymbols = Array.from({ length: 5 }, (_, i) => `TESTSCANMIXBS${i}`);
      const marketNowSymbols = Array.from({ length: 5 }, (_, i) => `TESTSCANMIXMN${i}`);
      const symbols = [...buyLimitSymbols, ...sellLimitSymbols, ...buyStopSymbols, ...marketNowSymbols];
      for (const s of symbols) await insertInstrument(s);
      const fixtures: Record<string, SymbolFixture> = {};
      for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
      setupMt5Mocks(fixtures);

      vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_poolArg, symbol) => {
        const s = symbol as string;
        if (s.startsWith('TESTSCANMIXBL')) {
          return cannedDetail({
            direction: 'BUY', action: 'WAIT_FOR_ENTRY', actionReason: 'PENDING_ENTRY_PLAN_READY',
            entryType: 'PULLBACK', pendingOrderType: 'BUY_LIMIT', entryPrice: 1.09, stopLoss: 1.08, takeProfit: 1.12,
          });
        }
        if (s.startsWith('TESTSCANMIXSL')) {
          return cannedDetail({
            direction: 'SELL', action: 'WAIT_FOR_ENTRY', actionReason: 'PENDING_ENTRY_PLAN_READY',
            entryType: 'PULLBACK', pendingOrderType: 'SELL_LIMIT', entryPrice: 1.11, stopLoss: 1.12, takeProfit: 1.08,
          });
        }
        if (s.startsWith('TESTSCANMIXBS')) {
          return cannedDetail({
            direction: 'BUY', action: 'WAIT_FOR_ENTRY', actionReason: 'PENDING_ENTRY_PLAN_READY',
            entryType: 'BREAKOUT', pendingOrderType: 'BUY_STOP', entryPrice: 1.12, stopLoss: 1.10, takeProfit: 1.16,
          });
        }
        return cannedDetail({
          direction: 'BUY', action: 'ENTER_NOW', actionReason: 'MARKET_ENTRY_READY',
          entryType: 'MARKET_NOW', pendingOrderType: 'NONE', entryPrice: 1.10, stopLoss: 1.09, takeProfit: 1.12,
        });
      });

      const result = await runOpportunityScan(pool, ACTOR, 20);

      expect(result.summary.aiShortlisted).toBe(20);
      expect(result.summary.actionable).toBeGreaterThan(0);
      expect(result.summary.actionable).toBe(20);
      expect(result.summary.technicalBlocked).toBe(0);
      expect(result.summary.aiProviderErrors).toBe(0);
      expect(result.summary.aiPlanValid).toBe(20);
      expect(result.summary.buyLimitValidCount).toBe(5);
      expect(result.summary.otherOrderTypeValidCount).toBe(15);
      expect(result.actionable.every((r) => r.technicalValid)).toBe(true);
      expect(result.actionable.every((r) => r.technicalBlockCode === null)).toBe(true);

      // A valid SELL_LIMIT plan is a valid AI plan — never technically
      // blocked, even though it is not part of the BUY-LIMIT-only top list.
      const sellLimitRow = result.actionable.find((r) => r.symbol === 'TESTSCANMIXSL0');
      expect(sellLimitRow).toBeDefined();
      expect(sellLimitRow?.technicalValid).toBe(true);
      expect(result.rejected.find((r) => r.symbol === 'TESTSCANMIXSL0')).toBeUndefined();
      expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANMIXSL0')).toBeUndefined();
    });
  });
});
