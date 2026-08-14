import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { getTestPool, setupTestDb } from './db/setup';
import { computeIntradaySessionStatus, Phase25Settings } from '../services/intraday-decision-service';
import { reconcileIntradayTimeExits } from '../services/trade-execution-service';
import {
  analyzeIntraday,
  cancelOrder,
  evaluateRisk,
  getMarketSnapshot,
  getPaperPortfolio,
  getTrackedSymbols,
  IntradayAnalysisDTO,
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
    analyzeIntraday: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000250';
const BROKER_RUN_ID = `intraday-${Date.now()}-${process.pid}`;
let brokerOrderSequence = 0;

function token() {
  process.env.SESSION_SECRET = 'test-secret-phase-25';
  return signToken({ sub: OWNER_ID, email: 'phase25-owner@test.example.com', role: 'owner' });
}

function buyAnalysis(overrides: Partial<IntradayAnalysisDTO> = {}): IntradayAnalysisDTO {
  return {
    symbol: 'AAPL',
    as_of: '2024-01-15T15:00:00.000Z',
    decision: 'BUY',
    confidence: 0.75,
    reasons: ['1h trend UP, 15m setup confirmed, 5m entry timing confirmed'],
    trend_direction: 'UP',
    trend_strength_pct: '1.50000000',
    setup_momentum_pct: '0.80000000',
    setup_volume_ratio: '1.20000000',
    setup_confirmed: true,
    entry_momentum_pct: '0.30000000',
    entry_volume_ratio: '1.10000000',
    entry_confirmed: true,
    volume_signal: 'CONFIRMED',
    atr: '2.00000000',
    atr_pct: '2.00000000',
    spread_pct: '0.05000000',
    liquidity_ok: true,
    entry_price: '100.00000000',
    stop_loss: '97.00000000',
    take_profit: '106.00000000',
    risk_reward: '2.00000000',
    expected_holding_minutes: 120,
    session_status: 'OPEN_FOR_ENTRIES',
    ...overrides,
  };
}

function holdAnalysis(overrides: Partial<IntradayAnalysisDTO> = {}): IntradayAnalysisDTO {
  return {
    ...buyAnalysis(),
    decision: 'HOLD',
    confidence: 0.2,
    reasons: ['5m entry timing (momentum + volume) not triggered'],
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    expected_holding_minutes: 0,
    ...overrides,
  };
}

function mockEngine() {
  vi.mocked(getMarketSnapshot).mockResolvedValue({
    symbol: 'AAPL',
    price: '100.00000000',
    bid: '99.99000000',
    ask: '100.01000000',
    volume: 1000,
    timestamp: '2024-01-15T15:00:00.000Z',
    is_stale: false,
  });
  vi.mocked(getPaperPortfolio).mockResolvedValue({
    cash: '50000.00000000',
    positions: {},
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
      price: '100.00000000',
      is_stale: false,
      timestamp: '2024-01-15T15:00:00.000Z',
    },
    portfolio_snapshot: {
      cash: '50000.00000000',
      positions: {},
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
          price: req.side === 'BUY' ? '100.00000000' : '101.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T15:01:00.000Z',
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

describe('computeIntradaySessionStatus (pure function, no DB)', () => {
  const settings: Phase25Settings = {
    intradayModeEnabled: true,
    trendEmaFast: 8,
    trendEmaSlow: 21,
    setupMomentumWindow: 6,
    setupVolumeWindow: 20,
    entryMomentumWindow: 3,
    entryVolumeWindow: 20,
    atrWindow: 14,
    stopAtrMultiple: '1.5',
    takeProfitAtrMultiple: '3.0',
    minRiskReward: '1.5',
    maxSpreadPct: '0.5',
    estimatedSlippagePct: '0.05',
    maxEstimatedSlippagePct: '0.25',
    minVolumeRatio: '1.0',
    maxHoldingMinutes: 120,
    defaultQuantity: '1',
    maxLossPerTradeUsd: '100',
    maxTradesPerSymbolPerDay: 3,
    maxTradesPerDayTotal: 10,
    cooldownSecondsPerSymbol: 900,
    sessionMarketOpen: '13:30',
    sessionMarketClose: '20:00',
    noNewTradesMinutesBeforeClose: 15,
    forceCloseBeforeCloseMinutes: 5,
    forceCloseEnabled: true,
  };

  it('is OPEN_FOR_ENTRIES mid-session', () => {
    expect(computeIntradaySessionStatus(new Date('2024-01-02T15:00:00Z'), settings)).toBe('OPEN_FOR_ENTRIES');
  });

  it('is CLOSED before the open', () => {
    expect(computeIntradaySessionStatus(new Date('2024-01-02T12:00:00Z'), settings)).toBe('CLOSED');
  });

  it('is CLOSED after the close', () => {
    expect(computeIntradaySessionStatus(new Date('2024-01-02T20:30:00Z'), settings)).toBe('CLOSED');
  });

  it('is NO_NEW_TRADES_NEAR_CLOSE inside the pre-close window', () => {
    expect(computeIntradaySessionStatus(new Date('2024-01-02T19:50:00Z'), settings)).toBe('NO_NEW_TRADES_NEAR_CLOSE');
  });

  it('is FORCE_CLOSE_WINDOW inside the force-close window', () => {
    expect(computeIntradaySessionStatus(new Date('2024-01-02T19:57:00Z'), settings)).toBe('FORCE_CLOSE_WINDOW');
  });
});

describe('Phase 25 intraday trading mode', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-phase-25';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'phase25-owner@test.example.com', 'Phase 25 Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    await pool.query("UPDATE system_settings SET value = '50000'::jsonb WHERE key = 'initial_paper_cash_usd'");
    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase25_intraday_mode_enabled'");
    await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase25_max_trades_per_symbol_per_day'");
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await resetTradingLedger(pool);
      await pool.query("UPDATE system_settings SET value = '100000'::jsonb WHERE key = 'initial_paper_cash_usd'");
      await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase25_intraday_mode_enabled'");
      await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase25_max_trades_per_symbol_per_day'");
      await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'");
      await pool.query('UPDATE system_settings SET updated_by = NULL WHERE updated_by = $1', [OWNER_ID]);
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

  it.skipIf(SKIP)('rejects when intraday mode is disabled', async () => {
    await pool.query("UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase25_intraday_mode_enabled'");
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/disabled/i);

    await pool.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase25_intraday_mode_enabled'");
  });

  it.skipIf(SKIP)('HOLD decision creates no proposal', async () => {
    vi.mocked(analyzeIntraday).mockResolvedValue(holdAnalysis());

    const res = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeNull();
    expect(res.body.analysis.decision).toBe('HOLD');
  });

  it.skipIf(SKIP)('BUY decision creates a PENDING_APPROVAL proposal with an ATR-derived phase25 bracket', async () => {
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.side).toBe('BUY');
    expect(res.body.proposal.riskSnapshot.phase25).toMatchObject({
      orderClass: 'BRACKET',
      stopLoss: '97.00000000',
      takeProfit: '106.00000000',
      result: 'PASS',
    });
  });

  it.skipIf(SKIP)('approval submits a bracket order with the ATR-derived stop/take-profit prices', async () => {
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase25-approve' });

    expect(approved.status).toBe(200);
    expect(approved.body.proposal.status).toBe('FILLED');
    expect(vi.mocked(submitOrder).mock.calls[0][0].bracket).toMatchObject({
      stop_loss_price: '97.00000000',
      take_profit_price: '106.00000000',
    });
  });

  it.skipIf(SKIP)('rejects when estimated slippage exceeds the configured maximum', async () => {
    await pool.query("UPDATE system_settings SET value = '5'::jsonb WHERE key = 'phase25_estimated_slippage_pct'");
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.proposal.riskSnapshot.phase25.failedRules).toContain('PHASE25_ESTIMATED_SLIPPAGE');

    await pool.query("UPDATE system_settings SET value = '0.05'::jsonb WHERE key = 'phase25_estimated_slippage_pct'");
  });

  it.skipIf(SKIP)('rejects once the per-symbol daily trade limit is reached', async () => {
    await pool.query("UPDATE system_settings SET value = '1'::jsonb WHERE key = 'phase25_max_trades_per_symbol_per_day'");
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());

    const first = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });
    const second = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });

    expect(first.status).toBe(201);
    expect(first.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(second.status).toBe(201);
    expect(second.body.proposal.status).toBe('RISK_REJECTED');
    expect(second.body.riskCheck.failedRules).toContain('PHASE25_MAX_TRADES_PER_SYMBOL_PER_DAY');

    await pool.query("UPDATE system_settings SET value = '3'::jsonb WHERE key = 'phase25_max_trades_per_symbol_per_day'");
  });

  it.skipIf(SKIP)('GET /intraday/analysis/:symbol returns the analysis and a sizing preview', async () => {
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());

    const res = await request(app)
      .get('/intraday/analysis/AAPL')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.analysis.decision).toBe('BUY');
    expect(res.body.sizingPreview.passed).toBe(true);
    expect(res.body.sizingPreview.snapshot.stopLoss).toBe('97.00000000');
  });

  it.skipIf(SKIP)('reconcileIntradayTimeExits auto-closes a position past its maximum holding time', async () => {
    vi.mocked(analyzeIntraday).mockResolvedValue(buyAnalysis());
    const created = await request(app)
      .post('/signals/intraday-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase25-time-exit-approve' });

    // Simulate the entry having happened long ago, past the configured
    // maximum holding time, without waiting in real time.
    await pool.query(
      `UPDATE orders SET created_at = NOW() - INTERVAL '999 minutes'
       WHERE execution_id = (
         SELECT e.id FROM executions e WHERE e.proposal_id = $1
       ) AND side = 'BUY'`,
      [created.body.proposal.id],
    );

    const result = await reconcileIntradayTimeExits(
      pool,
      { actorId: null, actorEmail: 'system-reconciliation@internal' },
      'phase25-time-exit',
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
    const second = await reconcileIntradayTimeExits(pool, undefined, 'phase25-time-exit-2');
    expect(second.checked).toBe(0);
    expect(second.closed).toBe(0);
  });
});
