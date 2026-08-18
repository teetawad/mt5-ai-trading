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
  PROMPT_VERSION: 'TRADING_AI_V3_PROMPT_001',
}));

import * as mt5Client from '../services/mt5-client';
import { analyzeSymbolWithAI } from '../services/trading-ai/trading-ai-service';
import { rankByTradeability, runOpportunityScan, ScanResultRow } from '../services/trading-ai/opportunity-scan';
import { Mt5Actor } from '../services/mt5-entry-plan-watcher';

function row(overrides: Partial<ScanResultRow> = {}): ScanResultRow {
  return {
    symbol: 'TEST', assetClass: 'FOREX', decision: 'BUY', action: 'WAIT_FOR_ENTRY', actionReason: 'PENDING_ENTRY_PLAN_READY', confidencePct: 70,
    tradeabilityPct: 50, tradeabilityRating: 'FAIR', tradeabilityRatingLabelTh: 'ปานกลาง', profitabilityScore: 50,
    tradeScore: 50, tradeRating: 'FAIR', tradeRatingLabelTh: 'พอเทรดได้',
    entryType: 'MARKET_NOW', pendingOrderType: 'NONE', currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null,
    planExpiry: null, planId: null, riskResult: 'PASS', riskFailedRules: null, riskReward: null,
    maxLoss: null, targetProfit: null, aiProvider: null, aiModel: null, aiPromptVersion: null,
    reasonSummary: null, error: null, reused: false,
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
  vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: true, account: {}, terminal: {} } as never);
  vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
  vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);

  vi.mocked(mt5Client.getMt5MarketStatus).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    if (!f) return { market_status: 'CLOSED', data_status: 'DISCONNECTED' } as never; // unknown/stray symbol -> never eligible
    return { market_status: f.marketStatus ?? 'OPEN', data_status: f.dataStatus ?? 'LIVE' } as never;
  });

  vi.mocked(mt5Client.getMt5SymbolInfo).mockImplementation(async (symbol: string) => {
    const f = fixtures[symbol];
    if (!f || f.symbolInfoUnavailable) throw new Error('symbol_info unavailable');
    return { point: 0.00001, digits: 5, trade_mode: f.tradeMode ?? 4 } as never;
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
  entryType?: string;
  pendingOrderType?: string;
  riskReward?: number | null;
  maxLoss?: string | null;
  targetProfit?: string | null;
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
    entryPlan: { entry_type: overrides.entryType ?? 'MARKET_NOW', pending_order_type: overrides.pendingOrderType ?? 'NONE' },
    quote: { bid: null, ask: null, currentPrice: null, spread: null },
    protection: { stopLoss: null, takeProfit: null, riskReward: overrides.riskReward ?? 2 },
    positionSizing: { maximumPlannedLoss: overrides.maxLoss ?? null, targetProfit: overrides.targetProfit ?? null },
    risk: { result: overrides.riskResult === undefined ? 'PASS' : overrides.riskResult, label: '', failedRules: [] },
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

  it('caps topOpportunities to the configured TOP N (default 10) even with more valid PASS candidates', async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => `TESTSCANTOP${i}`);
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      const idx = symbols.indexOf(symbol);
      // Descending distinct scores: 99, 98, ... so the ranking order is unambiguous.
      return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 99 - idx, riskResult: 'PASS' });
    });
    const result = await runOpportunityScan(pool, ACTOR, 12);
    const own = result.topOpportunities.filter((r) => symbols.includes(r.symbol));
    expect(own).toHaveLength(10);
    expect(own.map((r) => r.symbol)).toEqual(symbols.slice(0, 10));
    expect(result.summary.topOpportunitiesShown).toBe(10);
    // The full actionable list is never truncated — only the TOP N view is.
    expect(result.actionable.filter((r) => symbols.includes(r.symbol))).toHaveLength(12);
  });

  it('never marks a Risk-BLOCKED setup as READY — topOpportunities only ever contains Risk-PASS rows', async () => {
    await insertInstrument('TESTSCANREADYPASS');
    await insertInstrument('TESTSCANREADYBLOCKED');
    setupMt5Mocks({
      TESTSCANREADYPASS: { bars: TRENDING_BARS },
      TESTSCANREADYBLOCKED: { bars: FLAT_BARS },
    });
    vi.mocked(analyzeSymbolWithAI).mockImplementation(async (_pool, symbol) => {
      if (symbol === 'TESTSCANREADYBLOCKED') {
        // Deliberately the HIGHER profitability_score, to prove Risk-BLOCKED
        // is excluded from topOpportunities regardless of ranking position.
        return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 95, riskResult: 'REJECT' });
      }
      return cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 60, riskResult: 'PASS' });
    });
    const result = await runOpportunityScan(pool, ACTOR, 5);
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANREADYBLOCKED')).toBeUndefined();
    expect(result.topOpportunities.find((r) => r.symbol === 'TESTSCANREADYPASS')).toBeDefined();
    // Still visible (never hidden), just never presented as executable.
    expect(result.actionable.find((r) => r.symbol === 'TESTSCANREADYBLOCKED')?.riskResult).toBe('REJECT');
  });

  it('returns fewer than the TOP N cap when fewer valid PASS results exist — never fabricates more', async () => {
    const symbols = ['TESTSCANFEW0', 'TESTSCANFEW1', 'TESTSCANFEW2'];
    for (const s of symbols) await insertInstrument(s);
    const fixtures: Record<string, SymbolFixture> = {};
    for (const s of symbols) fixtures[s] = { bars: TRENDING_BARS };
    setupMt5Mocks(fixtures);
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 70, riskResult: 'PASS' }));
    const result = await runOpportunityScan(pool, ACTOR, 3);
    const own = result.topOpportunities.filter((r) => symbols.includes(r.symbol));
    expect(own).toHaveLength(3);
    expect(result.summary.topOpportunitiesShown).toBe(3);
  });

  it('persists the scan ranking dataset (spec section 20) for every topOpportunities row', async () => {
    await insertInstrument('TESTSCANDATASET');
    setupMt5Mocks({ TESTSCANDATASET: { bars: TRENDING_BARS } });
    vi.mocked(analyzeSymbolWithAI).mockResolvedValue(cannedDetail({ action: 'ENTER_NOW', profitabilityScore: 77, tradeabilityPct: 65, confidencePct: 72, riskReward: 2.5 }));
    const result = await runOpportunityScan(pool, ACTOR, 5);
    const persisted = await pool.query(`SELECT * FROM opportunity_scan_results WHERE scan_id = $1 AND symbol = $2`, [result.scanId, 'TESTSCANDATASET']);
    expect(persisted.rows).toHaveLength(1);
    const saved = persisted.rows[0];
    expect(saved.rank).toBe(result.topOpportunities.findIndex((r) => r.symbol === 'TESTSCANDATASET') + 1);
    expect(Number(saved.profitability_score)).toBe(77);
    expect(Number(saved.tradeability_pct)).toBe(65);
    expect(Number(saved.confidence_pct)).toBe(72);
    expect(saved.direction).toBe('BUY');
    expect(saved.action).toBe('ENTER_NOW');
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
    expect(reused?.profitabilityScore).toBe(88);
    expect(reused?.maxLoss).toBe('1.48000000');
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
});
