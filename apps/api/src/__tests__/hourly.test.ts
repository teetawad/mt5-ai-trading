import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { getTestPool, setupTestDb } from './db/setup';
import { reconcileHourlyTimeExits } from '../services/trade-execution-service';
import {
  HourlyAnalysisDTO,
  analyzeHourly,
  cancelOrder,
  evaluateRisk,
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
    evaluateRisk: vi.fn(),
    submitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    analyzeHourly: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000270';
const BROKER_RUN_ID = `hourly-${Date.now()}-${process.pid}`;
let brokerOrderSequence = 0;

function ownerToken() {
  process.env.SESSION_SECRET = 'test-secret-phase-27';
  return signToken({ sub: OWNER_ID, email: 'phase27-owner@test.example.com', role: 'owner' });
}

function viewerToken() {
  process.env.SESSION_SECRET = 'test-secret-phase-27';
  return signToken({ sub: OWNER_ID, email: 'phase27-viewer@test.example.com', role: 'viewer' });
}

function buyAnalysis(overrides: Partial<HourlyAnalysisDTO> = {}): HourlyAnalysisDTO {
  return {
    symbol: 'AAPL',
    as_of: '2024-01-15T15:00:00.000Z',
    candle_timestamp: '2024-01-15T14:00:00.000Z',
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
    ...overrides,
  };
}

function sellAnalysis(overrides: Partial<HourlyAnalysisDTO> = {}): HourlyAnalysisDTO {
  return {
    ...buyAnalysis(),
    decision: 'SELL',
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    reasons: ['1h trend reversed DOWN, momentum/volume and higher-timeframe confirmed: closing existing long position'],
    ...overrides,
  };
}

function holdAnalysis(overrides: Partial<HourlyAnalysisDTO> = {}): HourlyAnalysisDTO {
  return {
    ...buyAnalysis(),
    decision: 'HOLD',
    confidence: 0.2,
    reasons: ['1h momentum/volume does not confirm the trend'],
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    ...overrides,
  };
}

function mockEngine(positions: Record<string, string> = {}) {
  vi.mocked(getMarketSnapshot).mockResolvedValue({
    symbol: 'AAPL',
    price: '150.00000000',
    bid: '149.96000000',
    ask: '150.04000000',
    volume: 1_000_000,
    timestamp: '2024-01-15T15:00:00.000Z',
    is_stale: false,
  });
  vi.mocked(getPaperPortfolio).mockResolvedValue({
    cash: '50000.00000000',
    positions,
  });
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
      timestamp: '2024-01-15T15:00:00.000Z',
    },
    portfolio_snapshot: {
      cash: '50000.00000000',
      positions,
      equity: '50000.00000000',
      daily_pnl: '0.00000000',
    },
    evaluated_at: '2024-01-15T15:00:00.000Z',
  });
  vi.mocked(cancelOrder).mockResolvedValue(null);
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
          price: req.side === 'BUY' ? '150.00000000' : '150.50000000',
          fee: '1.00000000',
          is_partial: false,
          // Real wall-clock time (not a fixed past date) — the cooldown
          // check compares this against Date.now(), so a hardcoded 2024
          // timestamp would make every fill look infinitely old.
          filled_at: new Date().toISOString(),
        },
      ],
    };
  });
}

async function resetTradingLedger(pool: Pool) {
  await pool.query(
    `TRUNCATE audit_logs, fills, orders, executions, trade_approvals, risk_checks,
     trade_proposals, signals, positions, portfolio_snapshots
     RESTART IDENTITY CASCADE`,
  );
}

describe('Phase 27 hourly trading', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-phase-27';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'phase27-owner@test.example.com', 'Phase 27 Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    await pool.query("UPDATE system_settings SET value = '50000'::jsonb WHERE key = 'initial_paper_cash_usd'");
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
    await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase27_max_trades_per_symbol_per_day'");
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await resetTradingLedger(pool);
      await pool.query("UPDATE system_settings SET value = '100000'::jsonb WHERE key = 'initial_paper_cash_usd'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
      await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase27_max_trades_per_symbol_per_day'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
      await pool.query("DELETE FROM hourly_watchlist WHERE symbol <> 'AAPL'");
      await pool.query('UPDATE system_settings SET updated_by = NULL WHERE updated_by = $1', [OWNER_ID]);
      await pool.query('UPDATE hourly_watchlist SET updated_by = NULL WHERE updated_by = $1', [OWNER_ID]);
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    mockEngine();
    await resetTradingLedger(pool);
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
  });

  it.skipIf(SKIP)('rejects when hourly trading mode is disabled', async () => {
    await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/disabled/i);

    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase27_hourly_mode_enabled'");
  });

  it.skipIf(SKIP)('rejects an unsupported symbol', async () => {
    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'BTC/USD' });

    expect(res.status).toBe(422);
  });

  it.skipIf(SKIP)('HOLD decision creates no proposal', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(holdAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeNull();
    expect(res.body.analysis.decision).toBe('HOLD');
  });

  it.skipIf(SKIP)('risk rejection overrides an AI BUY decision (session not open for entries)', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis({ session_status: 'NO_NEW_TRADES_NEAR_CLOSE' }));

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.proposal.riskSnapshot.phase27.failedRules).toContain('PHASE27_SESSION_STATUS');
  });

  it.skipIf(SKIP)('BUY decision creates a PENDING_APPROVAL proposal with a whole-share ATR-derived phase27 bracket', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.side).toBe('BUY');
    expect(res.body.proposal.assetClass).toBe('STOCK');
    expect(res.body.proposal.riskSnapshot.phase27).toMatchObject({
      orderClass: 'BRACKET',
      candleTimestamp: '2024-01-15T14:00:00.000Z',
      strategyVersion: '27.0.0',
      stopLoss: '147.00000000',
      takeProfit: '156.00000000',
      result: 'PASS',
    });
    // whole-share (0dp) quantity — not fractional like crypto
    expect(Number.isInteger(Number(res.body.proposal.quantity))).toBe(true);
    expect(Number(res.body.proposal.quantity)).toBeGreaterThan(0);
  });

  it.skipIf(SKIP)('owner approval submits a bracket order and duplicate approval is idempotent', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ requestId: 'phase27-approve' });

    expect(approved.status).toBe(200);
    expect(approved.body.proposal.status).toBe('FILLED');
    const submittedOrder = vi.mocked(submitOrder).mock.calls[0][0];
    expect(submittedOrder.bracket).toMatchObject({
      stop_loss_price: '147.00000000',
      take_profit_price: '156.00000000',
    });
    expect(submittedOrder.fractionable).toBeUndefined();

    const duplicate = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ requestId: 'phase27-approve' });

    expect(duplicate.status).toBe(200);
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);
  });

  it.skipIf(SKIP)('SELL with an existing position closes it without a bracket', async () => {
    mockEngine({ AAPL: '10.00000000' });
    vi.mocked(analyzeHourly).mockResolvedValue(sellAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.side).toBe('SELL');
    expect(res.body.proposal.quantity).toBe('10.00000000');
    expect(res.body.proposal.riskSnapshot.phase27.orderClass).toBe('SINGLE');
  });

  it.skipIf(SKIP)('SELL without an open position is rejected before any order is built', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(sellAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/quantity/i);
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('rejects when estimated slippage exceeds the configured maximum', async () => {
    await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase27_estimated_slippage_pct'");
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.proposal.riskSnapshot.phase27.failedRules).toContain('PHASE27_ESTIMATED_SLIPPAGE');

    await pool.query("UPDATE system_settings SET value = '0.05'::jsonb WHERE key = 'phase27_estimated_slippage_pct'");
  });

  it.skipIf(SKIP)('rejects once the per-symbol daily trade limit is reached', async () => {
    await pool.query("UPDATE system_settings SET value = '1'::jsonb WHERE key = 'phase27_max_trades_per_symbol_per_day'");
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());

    const first = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });
    const second = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(first.status).toBe(201);
    expect(first.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(second.status).toBe(201);
    expect(second.body.proposal.status).toBe('RISK_REJECTED');
    expect(second.body.riskCheck.failedRules).toContain('PHASE27_MAX_TRADES_PER_SYMBOL_PER_DAY');

    await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase27_max_trades_per_symbol_per_day'");
  });

  it.skipIf(SKIP)('an approved-and-filled trade puts the symbol into cooldown for the next candle', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ requestId: 'phase27-cooldown-approve' });

    const next = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });

    expect(next.status).toBe(201);
    expect(next.body.proposal.status).toBe('RISK_REJECTED');
    expect(next.body.proposal.riskSnapshot.phase27.failedRules).toContain('PHASE27_COOLDOWN');
  });

  it.skipIf(SKIP)('reconcileHourlyTimeExits auto-closes a position past its maximum holding hours', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/hourly-decision')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'AAPL' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ requestId: 'phase27-time-exit-approve' });

    // Simulate the entry having happened long ago, past the configured
    // maximum holding hours, without waiting in real time.
    await pool.query(
      `UPDATE orders SET created_at = NOW() - INTERVAL '999 hours'
       WHERE execution_id = (
         SELECT e.id FROM executions e WHERE e.proposal_id = $1
       ) AND side = 'BUY'`,
      [created.body.proposal.id],
    );

    const result = await reconcileHourlyTimeExits(
      pool,
      { actorId: null, actorEmail: 'system-reconciliation@internal' },
      'phase27-time-exit',
    );

    expect(result.checked).toBe(1);
    expect(result.closed).toBe(1);
    expect(result.errors).toBe(0);
    expect(vi.mocked(cancelOrder)).toHaveBeenCalled();

    const exitOrder = await pool.query(
      `SELECT side, exit_reason FROM orders
       WHERE execution_id = (SELECT e.id FROM executions e WHERE e.proposal_id = $1)
       ORDER BY created_at DESC LIMIT 1`,
      [created.body.proposal.id],
    );
    expect(exitOrder.rows[0].side).toBe('SELL');
    expect(exitOrder.rows[0].exit_reason).toBe('MAX_HOLDING_TIME');

    // A second pass must be a no-op — the exit is already recorded.
    const second = await reconcileHourlyTimeExits(pool, undefined, 'phase27-time-exit-2');
    expect(second.checked).toBe(0);
    expect(second.closed).toBe(0);
  });

  it.skipIf(SKIP)('GET /hourly/analysis/:symbol returns the analysis and a sizing preview', async () => {
    vi.mocked(analyzeHourly).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .get('/hourly/analysis/AAPL')
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.analysis.decision).toBe('BUY');
    expect(res.body.sizingPreview.passed).toBe(true);
    expect(res.body.sizingPreview.snapshot.stopLoss).toBe('147.00000000');
    expect(res.body.hasOpenPosition).toBe(false);
  });

  it.skipIf(SKIP)('GET /hourly/watchlist returns the seeded AAPL entry', async () => {
    const res = await request(app)
      .get('/hourly/watchlist')
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.watchlist).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: 'AAPL', enabled: true })]),
    );
  });

  it.skipIf(SKIP)('owner can add and disable a watchlist symbol; non-owner cannot', async () => {
    const forbidden = await request(app)
      .post('/hourly/watchlist')
      .set('Authorization', `Bearer ${viewerToken()}`)
      .send({ symbol: 'MSFT' });
    expect(forbidden.status).toBe(403);

    const added = await request(app)
      .post('/hourly/watchlist')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbol: 'MSFT' });
    expect(added.status).toBe(201);
    expect(added.body.entry).toMatchObject({ symbol: 'MSFT', enabled: true });

    const disabled = await request(app)
      .patch(`/hourly/watchlist/${added.body.entry.id}`)
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.entry.enabled).toBe(false);
  });
});
