import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';
import { tick } from '../services/hourly-scheduler';
import { setWatchlistSymbolEnabled, listWatchlist } from '../db/repositories/hourly-watchlist';
import {
  HourlyAnalysisDTO,
  MarketBarDTO,
  analyzeHourly,
  evaluateRisk,
  getHistoricalBars,
  getMarketSnapshot,
  getPaperPortfolio,
  getTrackedSymbols,
  submitOrder,
} from '../services/trading-engine-client';

vi.mock('../services/trading-engine-client', async () => {
  const actual = await vi.importActual<typeof import('../services/trading-engine-client')>(
    '../services/trading-engine-client',
  );
  return {
    ...actual,
    getMarketSnapshot: vi.fn(),
    getPaperPortfolio: vi.fn(),
    getTrackedSymbols: vi.fn(),
    getHistoricalBars: vi.fn(),
    evaluateRisk: vi.fn(),
    submitOrder: vi.fn(),
    analyzeHourly: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const ONE_HOUR_MS = 3_600_000;
const BROKER_RUN_ID = `hourly-sched-${Date.now()}-${process.pid}`;
let brokerOrderSequence = 0;

function mostRecentClosedHourOpen(): Date {
  const now = Date.now();
  const currentHourOpen = Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS;
  return new Date(currentHourOpen - ONE_HOUR_MS);
}

function currentFormingHourOpen(): Date {
  const now = Date.now();
  return new Date(Math.floor(now / ONE_HOUR_MS) * ONE_HOUR_MS);
}

function bar(timestamp: Date): MarketBarDTO {
  return {
    symbol: 'AAPL',
    open: '150.00000000',
    high: '151.00000000',
    low: '149.00000000',
    close: '150.50000000',
    volume: 1_000_000,
    timestamp: timestamp.toISOString(),
  };
}

function buyAnalysis(candleTimestamp: Date): HourlyAnalysisDTO {
  return {
    symbol: 'AAPL',
    as_of: new Date().toISOString(),
    candle_timestamp: candleTimestamp.toISOString(),
    decision: 'BUY',
    confidence: 0.75,
    reasons: ['1h trend UP, momentum/volume and higher-timeframe confirmed'],
    strategy_version: '27.0.0',
    trend_direction: 'UP',
    trend_strength_pct: '1.50000000',
    momentum_pct: '0.80000000',
    volume_ratio: '1.20000000',
    breakout: true,
    pullback: false,
    higher_tf_trend_direction: 'UP',
    higher_tf_confirmed: true,
    atr: '2.00000000',
    atr_pct: '1.33000000',
    spread_pct: '0.05000000',
    liquidity_ok: true,
    entry_price: '150.00000000',
    stop_loss: '147.00000000',
    take_profit: '156.00000000',
    risk_reward: '2.00000000',
    expected_holding_hours: 8,
    session_status: 'OPEN_FOR_ENTRIES',
  };
}

function mockEngine() {
  vi.mocked(getMarketSnapshot).mockResolvedValue({
    symbol: 'AAPL',
    price: '150.00000000',
    bid: '149.96000000',
    ask: '150.04000000',
    volume: 1_000_000,
    timestamp: new Date().toISOString(),
    is_stale: false,
  });
  vi.mocked(getPaperPortfolio).mockResolvedValue({ cash: '50000.00000000', positions: {} });
  vi.mocked(getTrackedSymbols).mockResolvedValue(['AAPL', 'MSFT']);
  vi.mocked(evaluateRisk).mockResolvedValue({
    result: 'PASS',
    stage: 'PRE_PROPOSAL',
    rules_checked: ['KILL_SWITCH', 'TRADING_MODE'],
    failed_rules: [],
    reason: null,
    market_snapshot: {
      symbol: 'AAPL',
      price: '150.00000000',
      is_stale: false,
      timestamp: new Date().toISOString(),
    },
    portfolio_snapshot: {
      cash: '50000.00000000',
      positions: {},
      equity: '50000.00000000',
      daily_pnl: '0.00000000',
    },
    evaluated_at: new Date().toISOString(),
  });
  vi.mocked(submitOrder).mockImplementation(async (req) => {
    brokerOrderSequence += 1;
    const brokerOrderId = `${BROKER_RUN_ID}-${brokerOrderSequence}`;
    return {
      broker_order_id: brokerOrderId,
      status: 'FILLED',
      ...(req.bracket
        ? {
          bracket_order_ids: {
            parent: brokerOrderId,
            take_profit: `${brokerOrderId}-tp`,
            stop_loss: `${brokerOrderId}-sl`,
          },
        }
        : {}),
      fills: [
        {
          order_id: brokerOrderId,
          fill_id: `${brokerOrderId}-fill`,
          quantity: req.quantity,
          price: '150.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: new Date().toISOString(),
        },
      ],
    };
  });
}

async function resetTradingLedger(pool: Pool) {
  await pool.query(
    `TRUNCATE audit_logs, fills, orders, executions, trade_approvals, risk_checks,
     trade_proposals, signals, positions, portfolio_snapshots, hourly_candle_processing
     RESTART IDENTITY CASCADE`,
  );
}

describe('Phase 27 hourly scheduler', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (SKIP) return;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query("UPDATE system_settings SET value = '50000'::jsonb WHERE key = 'initial_paper_cash_usd'");
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
    const [{ id: aaplId }] = (await pool.query<{ id: string }>(
      "SELECT id FROM hourly_watchlist WHERE symbol = 'AAPL'",
    )).rows;
    await setWatchlistSymbolEnabled(pool, aaplId, true);
  });

  afterAll(async () => {
    if (pool) {
      await resetTradingLedger(pool);
      await pool.query("UPDATE system_settings SET value = '100000'::jsonb WHERE key = 'initial_paper_cash_usd'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
      const [{ id: aaplId }] = (await pool.query<{ id: string }>(
        "SELECT id FROM hourly_watchlist WHERE symbol = 'AAPL'",
      )).rows;
      await setWatchlistSymbolEnabled(pool, aaplId, true);
      await pool.end();
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEngine();
    await resetTradingLedger(pool);
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
    const [{ id: aaplId }] = (await pool.query<{ id: string }>(
      "SELECT id FROM hourly_watchlist WHERE symbol = 'AAPL'",
    )).rows;
    await setWatchlistSymbolEnabled(pool, aaplId, true);
  });

  it.skipIf(SKIP)('claims a newly closed candle and creates exactly one proposal', async () => {
    const candleOpen = mostRecentClosedHourOpen();
    vi.mocked(getHistoricalBars).mockResolvedValue([bar(candleOpen)]);
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis(candleOpen));

    const result = await tick(pool);

    expect(result.candlesClaimed).toBe(1);
    expect(result.signalsCreated).toBe(1);
    const { rows } = await pool.query(
      "SELECT status FROM hourly_candle_processing WHERE symbol = 'AAPL'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ANALYZED');
    const proposals = await pool.query("SELECT id FROM trade_proposals WHERE symbol = 'AAPL'");
    expect(proposals.rows).toHaveLength(1);
  });

  it.skipIf(SKIP)('a second tick with the same latest candle claims nothing new (restart-safety)', async () => {
    const candleOpen = mostRecentClosedHourOpen();
    vi.mocked(getHistoricalBars).mockResolvedValue([bar(candleOpen)]);
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis(candleOpen));

    const first = await tick(pool);
    expect(first.candlesClaimed).toBe(1);

    // Simulates a process restart calling tick() fresh — no in-memory state
    // carries over between calls, so this is the actual restart-safety test.
    const second = await tick(pool);
    expect(second.candlesClaimed).toBe(0);
    expect(second.signalsCreated).toBe(0);

    const proposals = await pool.query("SELECT id FROM trade_proposals WHERE symbol = 'AAPL'");
    expect(proposals.rows).toHaveLength(1);
  });

  it.skipIf(SKIP)('a still-forming candle (not yet closed) is never claimed', async () => {
    const formingCandleOpen = currentFormingHourOpen();
    vi.mocked(getHistoricalBars).mockResolvedValue([bar(formingCandleOpen)]);
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis(formingCandleOpen));

    const result = await tick(pool);

    expect(result.candlesClaimed).toBe(0);
    expect(result.signalsCreated).toBe(0);
    const { rows } = await pool.query(
      "SELECT status FROM hourly_candle_processing WHERE symbol = 'AAPL'",
    );
    expect(rows).toHaveLength(0);
  });

  it.skipIf(SKIP)('a disabled watchlist symbol is skipped entirely', async () => {
    const [{ id: aaplId }] = (await pool.query<{ id: string }>(
      "SELECT id FROM hourly_watchlist WHERE symbol = 'AAPL'",
    )).rows;
    await setWatchlistSymbolEnabled(pool, aaplId, false);

    const candleOpen = mostRecentClosedHourOpen();
    vi.mocked(getHistoricalBars).mockResolvedValue([bar(candleOpen)]);
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis(candleOpen));

    const result = await tick(pool);

    expect(result.symbolsChecked).toBe(0);
    expect(vi.mocked(getHistoricalBars)).not.toHaveBeenCalled();

    await setWatchlistSymbolEnabled(pool, aaplId, true);
  });

  it.skipIf(SKIP)('the whole tick is a no-op when hourly mode is disabled', async () => {
    await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
    const candleOpen = mostRecentClosedHourOpen();
    vi.mocked(getHistoricalBars).mockResolvedValue([bar(candleOpen)]);
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis(candleOpen));

    const result = await tick(pool);

    expect(result.symbolsChecked).toBe(0);
    expect(vi.mocked(getHistoricalBars)).not.toHaveBeenCalled();

    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
  });

  it.skipIf(SKIP)('sanity: watchlist listing reflects the seeded AAPL row', async () => {
    const watchlist = await listWatchlist(pool);
    expect(watchlist.map((w) => w.symbol)).toContain('AAPL');
  });
});
