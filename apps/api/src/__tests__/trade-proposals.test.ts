import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { createStrategy } from '../db/repositories/strategies';
import { getTestPool, setupTestDb } from './db/setup';
import { executeApprovedProposal } from '../services/trade-execution-service';
import { recordApprovedBracketExit } from '../services/trade-execution-service';
import { getDayStartEquity } from '../services/trade-execution-service';
import { reconcileBracketOrders } from '../services/trade-execution-service';
import { approveProposal } from '../services/trade-proposal-service';
import {
  evaluateRisk,
  getMarketSnapshot,
  getOrder,
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
    getOrder: vi.fn(),
    getPaperPortfolio: vi.fn(),
    getTrackedSymbols: vi.fn(),
    evaluateRisk: vi.fn(),
    submitOrder: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000080';
const BROKER_RUN_ID = `${Date.now()}-${process.pid}`;
let brokerOrderSequence = 0;

function token() {
  process.env.SESSION_SECRET = 'test-secret-phase-8';
  return signToken({ sub: OWNER_ID, email: 'phase8-owner@test.example.com', role: 'owner' });
}

function riskResult(
  result: 'PASS' | 'REJECT',
  failedRules: string[] = [],
  stage: 'PRE_PROPOSAL' | 'PRE_EXECUTION' = 'PRE_PROPOSAL',
) {
  return {
    result,
    stage,
    rules_checked: ['KILL_SWITCH', 'TRADING_MODE', 'MAX_ORDER_NOTIONAL'],
    failed_rules: failedRules,
    reason: failedRules.length ? 'Risk failed' : null,
    market_snapshot: {
      symbol: 'AAPL',
      price: '100.00000000',
      is_stale: false,
      timestamp: '2024-01-15T10:30:00.000Z',
    },
    portfolio_snapshot: {
      cash: '50000.00000000',
      positions: {},
      equity: '50000.00000000',
      daily_pnl: '0.00000000',
    },
    evaluated_at: '2024-01-15T10:30:00.000Z',
  };
}

function mockEngine(result: 'PASS' | 'REJECT' = 'PASS') {
  vi.mocked(getMarketSnapshot).mockResolvedValue({
    symbol: 'AAPL',
    price: '100.00000000',
    bid: '99.99000000',
    ask: '100.01000000',
    volume: 1000,
    timestamp: '2024-01-15T10:30:00.000Z',
    is_stale: false,
  });
  vi.mocked(getPaperPortfolio).mockResolvedValue({
    cash: '50000.00000000',
    positions: {},
  });
  vi.mocked(getTrackedSymbols).mockResolvedValue(['AAPL', 'MSFT']);
  vi.mocked(evaluateRisk).mockResolvedValue(
    result === 'PASS' ? riskResult('PASS') : riskResult('REJECT', ['MAX_ORDER_NOTIONAL']),
  );
  vi.mocked(submitOrder).mockImplementation(async () => {
    brokerOrderSequence += 1;
    return {
      broker_order_id: `broker-order-default-${BROKER_RUN_ID}-${brokerOrderSequence}`,
      status: 'FILLED',
      fills: [
        {
          order_id: `broker-order-default-${BROKER_RUN_ID}-${brokerOrderSequence}`,
          fill_id: `fill-${BROKER_RUN_ID}-${brokerOrderSequence}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    };
  });
}

function mockEngineSequence(...results: Array<'PASS' | 'REJECT'>) {
  mockEngine('PASS');
  vi.mocked(evaluateRisk).mockReset();
  for (const [index, result] of results.entries()) {
    vi.mocked(evaluateRisk).mockResolvedValueOnce(
      result === 'PASS'
        ? riskResult('PASS', [], index === 0 ? 'PRE_PROPOSAL' : 'PRE_EXECUTION')
        : riskResult('REJECT', ['PRICE_DRIFT'], index === 0 ? 'PRE_PROPOSAL' : 'PRE_EXECUTION'),
    );
  }
}

async function resetTradingLedger(pool: Pool) {
  await pool.query(
    `TRUNCATE audit_logs, fills, orders, executions, trade_approvals, risk_checks,
     trade_proposals, signals, positions, portfolio_snapshots
     RESTART IDENTITY CASCADE`,
  );
}

describe('Phase 8 route guards', () => {
  beforeEach(() => {
    _clearDenylistForTest();
    vi.clearAllMocks();
  });

  it('POST /signals requires authentication', async () => {
    const app = createApp();
    const res = await request(app).post('/signals').send({});
    expect(res.status).toBe(401);
  });

  it('POST /signals/manual-test requires authentication', async () => {
    const app = createApp();
    const res = await request(app).post('/signals/manual-test').send({});
    expect(res.status).toBe(401);
  });

  it('GET /trade-proposals requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/trade-proposals');
    expect(res.status).toBe(401);
  });

  it('POST approve requires authentication', async () => {
    const app = createApp();
    const res = await request(app).post('/trade-proposals/proposal-1/approve').send({});
    expect(res.status).toBe(401);
  });

  it('POST execute requires authentication', async () => {
    const app = createApp();
    const res = await request(app).post('/trade-proposals/proposal-1/execute').send({});
    expect(res.status).toBe(401);
  });

  it('POST reject requires owner role before opening a DB connection', async () => {
    process.env.SESSION_SECRET = 'test-secret-phase-9-viewer';
    const viewer = signToken({
      sub: 'viewer-1',
      email: 'viewer@test.example.com',
      role: 'viewer',
    });
    const app = createApp();
    const res = await request(app)
      .post('/trade-proposals/proposal-1/reject')
      .set('Authorization', `Bearer ${viewer}`)
      .send({ requestId: 'viewer-reject' });
    expect(res.status).toBe(403);
  });

  it('POST /signals/manual-test requires owner role before opening a DB connection', async () => {
    process.env.SESSION_SECRET = 'test-secret-manual-viewer';
    const viewer = signToken({
      sub: 'viewer-2',
      email: 'viewer2@test.example.com',
      role: 'viewer',
    });
    const app = createApp();
    const res = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${viewer}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1' });
    expect(res.status).toBe(403);
  });
});

describe('Phase 8 signal to proposal workflow', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let strategyId: string;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-phase-8';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'phase8-owner@test.example.com', 'Phase 8 Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    await pool.query(
      "UPDATE system_settings SET value = '50000'::jsonb WHERE key = 'initial_paper_cash_usd'",
    );
    await pool.query(
      "UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase22_prevent_duplicate_exposure'",
    );
    const strategy = await createStrategy(pool, {
      name: `phase-8-${Date.now()}`,
      version: '1.0.0',
    });
    strategyId = strategy.id;
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await pool.query(
        `TRUNCATE audit_logs, fills, orders, executions, trade_approvals, risk_checks,
         trade_proposals, signals, positions, portfolio_snapshots, strategies
         RESTART IDENTITY CASCADE`,
      );
      await pool.query(
        "UPDATE system_settings SET value = '100000'::jsonb WHERE key = 'initial_paper_cash_usd'",
      );
      await pool.query(
        "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase22_prevent_duplicate_exposure'",
      );
      await pool.query(
        "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
      );
      // Milestone 1b's auto-disable circuit breaker stamps updated_by with the
      // triggering owner; clear it so the owner row can be deleted below.
      await pool.query('UPDATE system_settings SET updated_by = NULL WHERE updated_by = $1', [OWNER_ID]);
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    mockEngine('PASS');
    // The MAX_DAILY_LOSS auto-disable circuit breaker is a real cross-request
    // safety feature (Milestone 1b) — it can legitimately trip from a prior
    // test's cumulative daily P&L in this shared, sequentially-run test DB.
    // Reset it here so each test starts from a known-good state, matching
    // how a fresh trading day would reset it in production.
    await pool.query(
      "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
    );
  });

  it.skipIf(SKIP)('POST /signals creates a signal, risk check, and pending proposal on risk pass', async () => {
    const res = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .set('X-Request-ID', 'phase-8-pass')
      .send({
        strategyId,
        symbol: 'aapl',
        side: 'BUY',
        quantity: '10.00000000',
        orderType: 'MARKET',
        reason: 'manual test signal',
      });

    expect(res.status).toBe(201);
    expect(res.body.signal.status).toBe('RISK_PASS');
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.symbol).toBe('AAPL');
    expect(res.body.riskCheck.result).toBe('PASS');
    expect(res.body.riskCheck.proposalId).toBe(res.body.proposal.id);
    expect(vi.mocked(evaluateRisk).mock.calls[0][0].config?.price_drift_threshold_pct).toBe('2');

    const signalRow = await pool.query('SELECT status FROM signals WHERE id = $1', [
      res.body.signal.id,
    ]);
    expect(signalRow.rows[0].status).toBe('RISK_PASS');
  });

  it.skipIf(SKIP)('POST /signals records a rejected proposal on risk reject', async () => {
    mockEngine('REJECT');
    const res = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '999.00000000',
        reason: 'too large',
      });

    expect(res.status).toBe(201);
    expect(res.body.signal.status).toBe('RISK_FAIL');
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.riskCheck.failedRules).toEqual(['MAX_ORDER_NOTIONAL']);

    const signalRow = await pool.query('SELECT status FROM signals WHERE id = $1', [
      res.body.signal.id,
    ]);
    expect(signalRow.rows[0].status).toBe('RISK_FAIL');
  });

  it.skipIf(SKIP)('GET /signals/manual-test/options lists supported paper symbols', async () => {
    vi.mocked(getTrackedSymbols).mockResolvedValueOnce(['MSFT', 'AAPL', 'BTCUSD']);

    const res = await request(app)
      .get('/signals/manual-test/options')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.symbols).toEqual(['AAPL', 'MSFT']);
  });

  it.skipIf(SKIP)('POST /signals/manual-test creates a paper-only signal through risk and proposal approval flow', async () => {
    const res = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${token()}`)
      .set('X-Request-ID', 'manual-paper-test-pass')
      .send({
        symbol: 'aapl',
        side: 'BUY',
        quantity: '1.00000000',
        referencePrice: '1.00000000',
      });

    expect(res.status).toBe(201);
    expect(res.body.signal.reason).toBe('MANUAL TEST / PAPER ONLY');
    expect(res.body.signal.status).toBe('RISK_PASS');
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.referencePrice).toBe('100.00000000');
    expect(res.body.proposal.symbol).toBe('AAPL');
    expect(vi.mocked(getMarketSnapshot)).toHaveBeenCalledWith('AAPL', 'manual-paper-test-pass');
    expect(vi.mocked(evaluateRisk).mock.calls[0][0]).toMatchObject({
      stage: 'PRE_PROPOSAL',
      proposal: {
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '1.00000000',
        reference_price: '100.00000000',
      },
    });
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('Phase 22 computes paper bracket risk controls server-side before approval', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '50000.00000000',
      positions: {},
    });

    const created = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '100.00000000',
      });

    expect(created.status).toBe(201);
    expect(created.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(created.body.proposal.quantity).toBe('48.00000000');
    expect(created.body.proposal.riskSnapshot.phase22).toMatchObject({
      phase: '22',
      source: 'SERVER_SIDE_RISK_CONTROLS',
      orderClass: 'BRACKET',
      entry: '100.00000000',
      stopLoss: '98.00000000',
      takeProfit: '104.00000000',
      result: 'PASS',
    });

    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase22-bracket-approve' });

    expect(approved.status).toBe(200);
    expect(vi.mocked(submitOrder).mock.calls.at(-1)?.[0]).toMatchObject({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '48.00000000',
      bracket: {
        stop_loss_price: '98.00000000',
        take_profit_price: '104.00000000',
      },
    });
  });

  it.skipIf(SKIP)('Phase 22 rejects unacceptable spread before owner approval', async () => {
    vi.mocked(getMarketSnapshot).mockResolvedValue({
      symbol: 'AAPL',
      price: '100.00000000',
      bid: '95.00000000',
      ask: '105.00000000',
      volume: 1000,
      timestamp: '2024-01-15T10:30:00.000Z',
      is_stale: false,
    });

    const res = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.riskCheck.failedRules).toContain('PHASE22_BID_ASK_SPREAD');
  });

  it.skipIf(SKIP)('Phase 22 prevents duplicate exposure when configured', async () => {
    await pool.query(
      "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'phase22_prevent_duplicate_exposure'",
    );
    vi.mocked(getPaperPortfolio).mockResolvedValueOnce({
      cash: '50000.00000000',
      positions: { AAPL: '1.00000000' },
    });

    try {
      const res = await request(app)
        .post('/signals/manual-test')
        .set('Authorization', `Bearer ${token()}`)
        .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

      expect(res.status).toBe(201);
      expect(res.body.proposal.status).toBe('RISK_REJECTED');
      expect(res.body.riskCheck.failedRules).toContain('PHASE22_DUPLICATE_EXPOSURE');
    } finally {
      await pool.query(
        "UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'phase22_prevent_duplicate_exposure'",
      );
    }
  });

  it.skipIf(SKIP)('Phase 23 AI BUY creates a proposal but never submits broker orders directly', async () => {
    mockEngineSequence('PASS');

    const res = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '10.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.aiDecision.decision).toBe('BUY');
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.proposal.riskSnapshot.aiDecision).toMatchObject({
      source: 'AI_ASSISTED_DECISION',
      decision: 'BUY',
    });
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('Phase 23 AI HOLD creates no trade', async () => {
    const res = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'HOLD', quantity: '1.00000000' });

    expect(res.status).toBe(200);
    expect(res.body.aiDecision.decision).toBe('HOLD');
    expect(res.body.signal).toBeNull();
    expect(res.body.proposal).toBeNull();
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('Phase 23 risk rejection overrides AI BUY', async () => {
    mockEngine('REJECT');

    const res = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.aiDecision.decision).toBe('BUY');
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.riskResult.result).toBe('REJECT');
    expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('Phase 23 owner approval creates exactly one paper bracket order and duplicate approval is idempotent', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: `phase23-bracket-parent-${BROKER_RUN_ID}`,
      status: 'FILLED',
      bracket_order_ids: {
        parent: `phase23-bracket-parent-${BROKER_RUN_ID}`,
        take_profit: `phase23-tp-${BROKER_RUN_ID}`,
        stop_loss: `phase23-sl-${BROKER_RUN_ID}`,
      },
      fills: [
        {
          order_id: `phase23-bracket-parent-${BROKER_RUN_ID}`,
          fill_id: `phase23-entry-fill-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    });

    const created = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    const first = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-approve-once' });
    const second = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-approve-once' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitOrder).mock.calls[0][0].bracket).toMatchObject({
      stop_loss_price: '98.00000000',
      take_profit_price: '104.00000000',
    });
    expect(first.body.order.bracketOrderIds).toMatchObject({
      take_profit: `phase23-tp-${BROKER_RUN_ID}`,
      stop_loss: `phase23-sl-${BROKER_RUN_ID}`,
    });

    const listed = await request(app)
      .get('/trade-proposals?limit=20')
      .set('Authorization', `Bearer ${token()}`);
    const listedProposal = listed.body.proposals.find(
      (proposal: { id: string }) => proposal.id === created.body.proposal.id,
    );
    expect(listed.status).toBe(200);
    expect(listedProposal).toMatchObject({
      id: created.body.proposal.id,
      status: 'FILLED',
      riskSnapshot: {
        aiDecision: {
          decision: 'BUY',
        },
        phase22: {
          orderClass: 'BRACKET',
          stopLoss: '98.00000000',
          takeProfit: '104.00000000',
        },
      },
    });

    const orderCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       JOIN executions e ON e.id = o.execution_id
       WHERE e.proposal_id = $1`,
      [created.body.proposal.id],
    );
    expect(orderCount.rows[0].count).toBe(1);
  });

  it.skipIf(SKIP)('Phase 23 take-profit bracket exit closes the position and cancels the stop-loss leg', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-tp-approve' });

    const exit = await recordApprovedBracketExit(pool, created.body.proposal.id, 'TAKE_PROFIT', {
      order_id: 'phase23-tp-order',
      fill_id: `phase23-tp-fill-${BROKER_RUN_ID}`,
      quantity: '1.00000000',
      price: '104.00000000',
      fee: '1.00000000',
      is_partial: false,
      filled_at: '2024-01-15T10:35:00.000Z',
    }, { actorId: OWNER_ID, actorEmail: 'phase8-owner@test.example.com' });

    expect(exit.position?.quantity).toBe('0.00000000');
    expect(exit.order?.exitReason).toBe('TAKE_PROFIT');
    expect(exit.order?.bracketOrderIds.cancelled_leg).toBe('stop_loss');
  });

  it.skipIf(SKIP)('Phase 23 stop-loss bracket exit closes the position and cancels the take-profit leg', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-sl-approve' });

    const exit = await recordApprovedBracketExit(pool, created.body.proposal.id, 'STOP_LOSS', {
      order_id: 'phase23-sl-order',
      fill_id: `phase23-sl-fill-${BROKER_RUN_ID}`,
      quantity: '1.00000000',
      price: '98.00000000',
      fee: '1.00000000',
      is_partial: false,
      filled_at: '2024-01-15T10:35:00.000Z',
    }, { actorId: OWNER_ID, actorEmail: 'phase8-owner@test.example.com' });

    expect(exit.position?.quantity).toBe('0.00000000');
    expect(exit.order?.exitReason).toBe('STOP_LOSS');
    expect(exit.order?.bracketOrderIds.cancelled_leg).toBe('take_profit');
  });

  it.skipIf(SKIP)('reconcileBracketOrders closes a position when the broker reports a filled take-profit leg', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: `reconcile-parent-${BROKER_RUN_ID}`,
      status: 'FILLED',
      bracket_order_ids: {
        parent: `reconcile-parent-${BROKER_RUN_ID}`,
        take_profit: `reconcile-tp-${BROKER_RUN_ID}`,
        stop_loss: `reconcile-sl-${BROKER_RUN_ID}`,
      },
      fills: [
        {
          order_id: `reconcile-parent-${BROKER_RUN_ID}`,
          fill_id: `reconcile-entry-fill-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    });

    const created = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'reconcile-approve' });

    vi.mocked(getOrder).mockImplementation(async (brokerOrderId: string) => {
      if (brokerOrderId === `reconcile-tp-${BROKER_RUN_ID}`) {
        return {
          broker_order_id: brokerOrderId,
          status: 'FILLED',
          fills: [
            {
              order_id: brokerOrderId,
              fill_id: `reconcile-tp-fill-${BROKER_RUN_ID}`,
              quantity: '1.00000000',
              price: '104.00000000',
              fee: '1.00000000',
              is_partial: false,
              filled_at: '2024-01-15T10:36:00.000Z',
            },
          ],
        };
      }
      return { broker_order_id: brokerOrderId, status: 'CANCELLED', fills: [] };
    });

    const outcome = await reconcileBracketOrders(pool);

    expect(outcome.checked).toBe(1);
    expect(outcome.reconciled).toBe(1);
    expect(outcome.errors).toBe(0);

    const order = await pool.query(
      `SELECT exit_reason FROM orders WHERE symbol = 'AAPL' AND side = 'SELL' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(order.rows[0].exit_reason).toBe('TAKE_PROFIT');

    const position = await pool.query("SELECT quantity FROM positions WHERE symbol = 'AAPL'");
    expect(position.rows[0].quantity).toBe('0.00000000');

    // idempotent: a second reconciliation pass finds nothing left to do
    const second = await reconcileBracketOrders(pool);
    expect(second.checked).toBe(0);
  });

  it.skipIf(SKIP)('Phase 23 approved AI plan is immutable', async () => {
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-immutable-approve' });

    await expect(pool.query(
      "UPDATE trade_proposals SET risk_snapshot = jsonb_set(risk_snapshot, '{phase22,stopLoss}', '\"99.00000000\"'::jsonb) WHERE id = $1",
      [created.body.proposal.id],
    )).rejects.toThrow(/Cannot modify approved trading plan/);
  });

  it.skipIf(SKIP)('Phase 23 pending paper order blocks duplicate AI entry', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: `phase23-pending-parent-${BROKER_RUN_ID}`,
      status: 'SUBMITTED',
      fills: [],
    });
    const first = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
    await request(app)
      .post(`/trade-proposals/${first.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase23-pending-approve' });

    const duplicate = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

    expect(duplicate.status).toBe(201);
    expect(duplicate.body.proposal.status).toBe('RISK_REJECTED');
    expect(duplicate.body.riskCheck.failedRules).toContain('PHASE22_DUPLICATE_PENDING_ORDER');
  });

  it.skipIf(SKIP)('Phase 23 cooldown blocks AI entry after a recent fill', async () => {
    await resetTradingLedger(pool);
    await pool.query(
      "UPDATE system_settings SET value = '3600'::jsonb WHERE key = 'cooldown_between_trades_seconds'",
    );
    mockEngineSequence('PASS', 'PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: `phase23-cooldown-parent-${BROKER_RUN_ID}`,
      status: 'FILLED',
      fills: [
        {
          order_id: `phase23-cooldown-parent-${BROKER_RUN_ID}`,
          fill_id: `phase23-cooldown-fill-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: new Date().toISOString(),
        },
      ],
    });
    try {
      const first = await request(app)
        .post('/signals/ai-decision')
        .set('Authorization', `Bearer ${token()}`)
        .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });
      await request(app)
        .post(`/trade-proposals/${first.body.proposal.id}/approve`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ requestId: 'phase23-cooldown-approve' });

      const blocked = await request(app)
        .post('/signals/ai-decision')
        .set('Authorization', `Bearer ${token()}`)
        .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

      expect(blocked.status).toBe(201);
      expect(blocked.body.proposal.status).toBe('RISK_REJECTED');
      expect(blocked.body.riskCheck.failedRules).toContain('PHASE22_COOLDOWN');
    } finally {
      await pool.query(
        "UPDATE system_settings SET value = '0'::jsonb WHERE key = 'cooldown_between_trades_seconds'",
      );
    }
  });

  it.skipIf(SKIP)('Phase 23 daily loss limit blocks AI entry', async () => {
    await resetTradingLedger(pool);
    await pool.query(
      `INSERT INTO portfolio_snapshots
       (cash_balance, portfolio_equity, open_positions, pending_orders, realized_pnl, unrealized_pnl, daily_pnl, snapshot_reason)
       VALUES ('49000.00000000', '49000.00000000', '[]'::jsonb, '[]'::jsonb, '-1001.00000000', '0.00000000', '-1001.00000000', 'PHASE23_DAILY_LOSS_TEST')`,
    );
    mockEngineSequence('PASS');

    const blocked = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

    expect(blocked.status).toBe(201);
    expect(blocked.body.proposal.status).toBe('RISK_REJECTED');
    expect(blocked.body.riskCheck.failedRules).toContain('PHASE22_MAX_DAILY_LOSS');
  });

  it.skipIf(SKIP)('Phase 23 max trade loss reduces AI requested position size', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS');

    const res = await request(app)
      .post('/signals/ai-decision')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '100.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('PENDING_APPROVAL');
    expect(res.body.aiDecision.suggestedPositionSize).toBe('100.00000000');
    expect(res.body.proposal.quantity).toBe('48.00000000');
    expect(res.body.proposal.riskSnapshot.phase22.maxLoss).toBe('99.40000000');
  });

  it.skipIf(SKIP)('POST /signals/manual-test rejects unsupported symbols server-side', async () => {
    vi.mocked(getTrackedSymbols).mockResolvedValueOnce(['AAPL']);

    const res = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${token()}`)
      .send({ symbol: 'TSLA', side: 'BUY', quantity: '1.00000000' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(vi.mocked(getMarketSnapshot)).not.toHaveBeenCalled();
  });

  it.skipIf(SKIP)('GET /trade-proposals lists and reads proposals', async () => {
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '2.00000000',
        reason: 'list test',
      });

    const listRes = await request(app)
      .get('/trade-proposals?status=PENDING_APPROVAL')
      .set('Authorization', `Bearer ${token()}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.proposals.some((p: { id: string }) => p.id === created.body.proposal.id))
      .toBe(true);

    const detailRes = await request(app)
      .get(`/trade-proposals/${created.body.proposal.id}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(created.body.proposal.id);
  });

  it.skipIf(SKIP)('PATCH /trade-proposals/:id/cancel cancels a pending proposal', async () => {
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '3.00000000',
        reason: 'cancel test',
      });

    const res = await request(app)
      .patch(`/trade-proposals/${created.body.proposal.id}/cancel`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it.skipIf(SKIP)('PATCH cancel rejects terminal states', async () => {
    mockEngine('REJECT');
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '4.00000000',
        reason: 'terminal cancel test',
      });

    const res = await request(app)
      .patch(`/trade-proposals/${created.body.proposal.id}/cancel`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INVALID_STATE');
  });

  it.skipIf(SKIP)('POST approve revalidates risk and submits exactly one paper order on pass', async () => {
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '5.00000000',
        reason: 'approval pass test',
      });

    const res = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'approve-pass-1' });

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('FILLED');
    expect(res.body.approval.action).toBe('APPROVE');
    expect(res.body.riskResult.stage).toBe('PRE_EXECUTION');
    expect(res.body.execution.status).toBe('FILLED');
    expect(res.body.order.status).toBe('FILLED');
    expect(res.body.fills).toHaveLength(1);
    expect(vi.mocked(evaluateRisk).mock.calls[1][0].stage).toBe('PRE_EXECUTION');
    expect(vi.mocked(evaluateRisk).mock.calls[1][0].proposal.expires_at).toBeDefined();
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);

    const executionRows = await pool.query('SELECT id FROM executions WHERE proposal_id = $1', [
      created.body.proposal.id,
    ]);
    const orderRows = await pool.query(
      'SELECT id FROM orders WHERE execution_id IN (SELECT id FROM executions WHERE proposal_id = $1)',
      [created.body.proposal.id],
    );
    expect(executionRows.rowCount).toBe(1);
    expect(orderRows.rowCount).toBe(1);
  });

  it.skipIf(SKIP)('POST approve is idempotent for duplicate requestId', async () => {
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '6.00000000',
        reason: 'approval idempotency test',
      });

    const first = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'approve-idempotent-1' });
    const second = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'approve-idempotent-1' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.approval.id).toBe(first.body.approval.id);
    expect(second.body.execution.id).toBe(first.body.execution.id);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);

    const executionRows = await pool.query('SELECT id FROM executions WHERE proposal_id = $1', [
      created.body.proposal.id,
    ]);
    const orderRows = await pool.query(
      'SELECT id FROM orders WHERE execution_id IN (SELECT id FROM executions WHERE proposal_id = $1)',
      [created.body.proposal.id],
    );
    expect(executionRows.rowCount).toBe(1);
    expect(orderRows.rowCount).toBe(1);
  });

  it.skipIf(SKIP)('POST approve records risk rejection after owner approval', async () => {
    mockEngineSequence('PASS', 'REJECT');
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '7.00000000',
        reason: 'approval risk reject test',
      });

    const res = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'approve-risk-reject-1' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('RISK_REVALIDATION_FAILED');
    expect(res.body.proposal.status).toBe('RISK_REJECTED_AFTER_APPROVAL');
    expect(res.body.failedRules).toEqual(['PRICE_DRIFT']);
  });

  it.skipIf(SKIP)('POST reject marks proposal owner rejected', async () => {
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '8.00000000',
        reason: 'owner reject test',
      });

    const res = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/reject`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'reject-1', reason: 'No longer wanted' });

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('OWNER_REJECTED');
    expect(res.body.approval.action).toBe('REJECT');
    expect(res.body.approval.reason).toBe('No longer wanted');
  });

  it.skipIf(SKIP)('POST approve rejects expired proposals', async () => {
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '9.00000000',
        reason: 'expired approval test',
      });

    await pool.query('UPDATE trade_proposals SET expires_at = NOW() - INTERVAL \'1 second\' WHERE id = $1', [
      created.body.proposal.id,
    ]);

    const res = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'approve-expired-1' });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('PROPOSAL_EXPIRED');
  });

  it.skipIf(SKIP)('competing approvals do not both approve the same proposal', async () => {
    mockEngineSequence('PASS', 'PASS');
    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '11.00000000',
        reason: 'competing approval test',
      });

    const first = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'competing-approve-1' });
    const second = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'competing-approve-2' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('INVALID_STATE');
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);
  });

  it.skipIf(SKIP)('POST execute submits an approved proposal to the paper broker and records fills', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: 'broker-order-execute-1',
      status: 'FILLED',
      fills: [
        {
          order_id: 'broker-order-execute-1',
          fill_id: 'broker-fill-execute-1',
          quantity: '12.00000000',
          price: '101.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    });

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '12.00000000',
        reason: 'phase 10 execute test',
      });
    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-approve-1' });

    const res = await request(app)
      .post(`/trade-proposals/${approved.body.proposal.id}/execute`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-execute-1' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.proposal.status).toBe('FILLED');
    expect(res.body.execution.status).toBe('FILLED');
    expect(res.body.execution.idempotencyKey).toBe(`proposal:${approved.body.proposal.id}:attempt:1`);
    expect(res.body.order.status).toBe('FILLED');
    expect(res.body.order.filledQuantity).toBe('12.00000000');
    expect(res.body.fills).toHaveLength(1);
    expect(res.body.position.quantity).toBeDefined();
    expect(vi.mocked(submitOrder).mock.calls[0][0]).toMatchObject({
      idempotency_key: `proposal:${approved.body.proposal.id}:attempt:1`,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '12.00000000',
      order_type: 'MARKET',
    });
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);
  });

  it.skipIf(SKIP)('POST execute is idempotent and does not submit duplicate paper orders', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: 'broker-order-idempotent-1',
      status: 'FILLED',
      fills: [
        {
          order_id: 'broker-order-idempotent-1',
          fill_id: 'broker-fill-idempotent-1',
          quantity: '13.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    });

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '13.00000000',
        reason: 'phase 10 idempotent test',
      });
    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-approve-2' });

    const first = await request(app)
      .post(`/trade-proposals/${approved.body.proposal.id}/execute`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-execute-2' });
    const second = await request(app)
      .post(`/trade-proposals/${approved.body.proposal.id}/execute`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-execute-2-retry' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.idempotent).toBe(true);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.execution.id).toBe(first.body.execution.id);
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(1);
  });

  it.skipIf(SKIP)('POST execute records paper broker rejections without fills', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: 'broker-order-reject-1',
      status: 'REJECTED',
      fills: [],
      rejected_reason: 'Insufficient paper funds',
    });

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '14.00000000',
        reason: 'phase 10 rejection test',
      });
    const res = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-approve-3' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EXECUTION_REJECTED');
    expect(res.body.proposal.status).toBe('EXECUTION_REJECTED');
    expect(res.body.execution.status).toBe('REJECTED');
    expect(res.body.fills).toEqual([]);
  });

  it.skipIf(SKIP)('POST approve rechecks kill switch before broker submission', async () => {
    mockEngineSequence('PASS', 'PASS');

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '18.00000000',
        reason: 'phase 13 execution kill switch test',
      });
    await pool.query(
      "UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'trading_kill_switch_enabled'",
    );
    try {
      const res = await request(app)
        .post(`/trade-proposals/${created.body.proposal.id}/approve`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ requestId: 'phase-13-approve-kill-switch' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('EXECUTION_BLOCKED');
      expect(res.body.failedRule).toBe('KILL_SWITCH');
      expect(vi.mocked(submitOrder)).not.toHaveBeenCalled();

      const proposalRow = await pool.query('SELECT status FROM trade_proposals WHERE id = $1', [
        created.body.proposal.id,
      ]);
      const executionRows = await pool.query('SELECT id FROM executions WHERE proposal_id = $1', [
        created.body.proposal.id,
      ]);
      expect(proposalRow.rows[0].status).toBe('APPROVED');
      expect(executionRows.rowCount).toBe(0);
    } finally {
      await pool.query(
        "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
      );
    }
  });

  it.skipIf(SKIP)('execution DB errors roll back proposal state and execution rows', async () => {
    mockEngineSequence('PASS', 'PASS', 'PASS', 'PASS');
    vi.mocked(submitOrder)
      .mockResolvedValueOnce({
        broker_order_id: 'broker-order-db-conflict',
        status: 'FILLED',
        fills: [
          {
            order_id: 'broker-order-db-conflict',
            fill_id: 'broker-fill-db-conflict-1',
            quantity: '15.00000000',
            price: '100.00000000',
            fee: '1.00000000',
            is_partial: false,
            filled_at: '2024-01-15T10:31:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        broker_order_id: 'broker-order-db-conflict',
        status: 'FILLED',
        fills: [
          {
            order_id: 'broker-order-db-conflict',
            fill_id: 'broker-fill-db-conflict-2',
            quantity: '17.00000000',
            price: '100.00000000',
            fee: '1.00000000',
            is_partial: false,
            filled_at: '2024-01-15T10:32:00.000Z',
          },
        ],
      });

    const first = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '15.00000000',
        reason: 'phase 12 db rollback first',
      });
    const firstApproved = await approveProposal(pool, first.body.proposal.id, {
      actorId: OWNER_ID,
      actorEmail: 'phase8-owner@test.example.com',
      requestId: 'phase-12-db-approve-1',
    });
    await executeApprovedProposal(pool, firstApproved.proposal.id, {
      actorId: OWNER_ID,
      actorEmail: 'phase8-owner@test.example.com',
      requestId: 'phase-12-db-execute-1',
    });

    const second = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '17.00000000',
        reason: 'phase 12 db rollback second',
      });
    const secondApproved = await approveProposal(pool, second.body.proposal.id, {
      actorId: OWNER_ID,
      actorEmail: 'phase8-owner@test.example.com',
      requestId: 'phase-12-db-approve-2',
    });

    await expect(
      executeApprovedProposal(pool, secondApproved.proposal.id, {
        actorId: OWNER_ID,
        actorEmail: 'phase8-owner@test.example.com',
        requestId: 'phase-12-db-execute-2',
      }),
    ).rejects.toThrow();

    const proposalRow = await pool.query('SELECT status FROM trade_proposals WHERE id = $1', [
      secondApproved.proposal.id,
    ]);
    const executionRows = await pool.query('SELECT id FROM executions WHERE proposal_id = $1', [
      secondApproved.proposal.id,
    ]);
    const fillRows = await pool.query("SELECT id FROM fills WHERE broker_fill_id = 'broker-fill-db-conflict-2'");

    expect(proposalRow.rows[0].status).toBe('APPROVED');
    expect(executionRows.rowCount).toBe(0);
    expect(fillRows.rowCount).toBe(0);
  });

  it.skipIf(SKIP)('POST execute records partial fills without completing the proposal', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder).mockResolvedValueOnce({
      broker_order_id: 'broker-order-partial-1',
      status: 'PARTIALLY_FILLED',
      fills: [
        {
          order_id: 'broker-order-partial-1',
          fill_id: 'broker-fill-partial-1',
          quantity: '8.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: true,
          filled_at: '2024-01-15T10:31:00.000Z',
        },
      ],
    });

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '16.00000000',
        reason: 'phase 12 partial fill test',
      });
    const approved = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-12-approve-partial' });

    const res = await request(app)
      .post(`/trade-proposals/${approved.body.proposal.id}/execute`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-12-execute-partial' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.proposal.status).toBe('PARTIALLY_FILLED');
    expect(res.body.execution.status).toBe('PARTIALLY_FILLED');
    expect(res.body.order.status).toBe('PARTIALLY_FILLED');
    expect(res.body.order.filledQuantity).toBe('8.00000000');
    expect(res.body.fills[0].fillType).toBe('PARTIAL');
    expect(res.body.position.quantity).toBeDefined();
  });

  it.skipIf(SKIP)('closing a paper position carries realized P&L into the latest portfolio snapshot', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS', 'PASS', 'PASS');
    vi.mocked(getPaperPortfolio).mockReset();
    vi.mocked(getPaperPortfolio)
      .mockResolvedValueOnce({ cash: '50000.00000000', positions: {} })
      .mockResolvedValueOnce({ cash: '50000.00000000', positions: {} })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { MSFT: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { MSFT: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { MSFT: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49997.93000000', positions: {} });
    vi.mocked(submitOrder)
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-close-pnl-buy-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [
          {
            order_id: `broker-order-close-pnl-buy-${BROKER_RUN_ID}`,
            fill_id: `broker-fill-close-pnl-buy-${BROKER_RUN_ID}`,
            quantity: '1.00000000',
            price: '100.00000000',
            fee: '1.00000000',
            is_partial: false,
            filled_at: '2024-01-15T10:31:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-close-pnl-sell-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [
          {
            order_id: `broker-order-close-pnl-sell-${BROKER_RUN_ID}`,
            fill_id: `broker-fill-close-pnl-sell-${BROKER_RUN_ID}`,
            quantity: '1.00000000',
            price: '99.93000000',
            fee: '1.00000000',
            is_partial: false,
            filled_at: '2024-01-15T10:32:00.000Z',
          },
        ],
      });

    const buy = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'MSFT',
        side: 'BUY',
        quantity: '1.00000000',
        reason: 'close pnl buy',
      });
    await request(app)
      .post(`/trade-proposals/${buy.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'close-pnl-buy-approve' });

    const sell = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'MSFT',
        side: 'SELL',
        quantity: '1.00000000',
        reason: 'close pnl sell',
      });
    const closed = await request(app)
      .post(`/trade-proposals/${sell.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'close-pnl-sell-approve' });

    expect(closed.status).toBe(200);
    expect(closed.body.position.quantity).toBe('0.00000000');
    expect(closed.body.position.realizedPnl).toBe('-2.07000000');

    const latestSnapshot = await pool.query(
      'SELECT cash_balance, portfolio_equity, realized_pnl, unrealized_pnl FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1',
    );
    expect(latestSnapshot.rows[0].cash_balance).toBe('49997.93000000');
    expect(latestSnapshot.rows[0].portfolio_equity).toBe('49997.93000000');
    expect(latestSnapshot.rows[0].realized_pnl).toBe('-2.07000000');
    const closedPosition = await pool.query(
      "SELECT unrealized_pnl FROM positions WHERE symbol = 'MSFT'",
    );
    expect(closedPosition.rows[0].unrealized_pnl).toBe('0.00000000');
  });

  it.skipIf(SKIP)('multiple sequential paper round trips keep realized P&L aligned with cash equity', async () => {
    await resetTradingLedger(pool);
    mockEngineSequence('PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS');
    vi.mocked(getPaperPortfolio).mockReset();
    vi.mocked(getPaperPortfolio)
      .mockResolvedValueOnce({ cash: '50000.00000000', positions: {} })
      .mockResolvedValueOnce({ cash: '50000.00000000', positions: {} })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49899.00000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49997.93000000', positions: {} })
      .mockResolvedValueOnce({ cash: '49997.93000000', positions: {} })
      .mockResolvedValueOnce({ cash: '49997.93000000', positions: {} })
      .mockResolvedValueOnce({ cash: '49896.93000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49896.93000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49896.93000000', positions: { PNLA: '1.00000000' } })
      .mockResolvedValueOnce({ cash: '49995.65000000', positions: {} });
    vi.mocked(submitOrder)
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-seq-pnl-buy-1-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [ {
          order_id: `broker-order-seq-pnl-buy-1-${BROKER_RUN_ID}`,
          fill_id: `broker-fill-seq-pnl-buy-1-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:31:00.000Z',
        } ],
      })
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-seq-pnl-sell-1-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [ {
          order_id: `broker-order-seq-pnl-sell-1-${BROKER_RUN_ID}`,
          fill_id: `broker-fill-seq-pnl-sell-1-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '99.93000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:32:00.000Z',
        } ],
      })
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-seq-pnl-buy-2-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [ {
          order_id: `broker-order-seq-pnl-buy-2-${BROKER_RUN_ID}`,
          fill_id: `broker-fill-seq-pnl-buy-2-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '100.00000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:33:00.000Z',
        } ],
      })
      .mockResolvedValueOnce({
        broker_order_id: `broker-order-seq-pnl-sell-2-${BROKER_RUN_ID}`,
        status: 'FILLED',
        fills: [ {
          order_id: `broker-order-seq-pnl-sell-2-${BROKER_RUN_ID}`,
          fill_id: `broker-fill-seq-pnl-sell-2-${BROKER_RUN_ID}`,
          quantity: '1.00000000',
          price: '99.72000000',
          fee: '1.00000000',
          is_partial: false,
          filled_at: '2024-01-15T10:34:00.000Z',
        } ],
      });

    for (const [index, side] of ['BUY', 'SELL', 'BUY', 'SELL'].entries()) {
      const created = await request(app)
        .post('/signals')
        .set('Authorization', `Bearer ${token()}`)
        .send({
          strategyId,
          symbol: 'PNLA',
          side,
          quantity: '1.00000000',
          reason: `sequential pnl ${index}`,
        });
      const approved = await request(app)
        .post(`/trade-proposals/${created.body.proposal.id}/approve`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ requestId: `sequential-pnl-${index}` });

      expect(approved.status).toBe(200);
    }

    const latestSnapshot = await pool.query(
      'SELECT cash_balance, portfolio_equity, realized_pnl, unrealized_pnl FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1',
    );
    expect(latestSnapshot.rows[0].cash_balance).toBe('49995.65000000');
    expect(latestSnapshot.rows[0].portfolio_equity).toBe('49995.65000000');
    expect(latestSnapshot.rows[0].unrealized_pnl).toBe('0.00000000');
    expect(latestSnapshot.rows[0].realized_pnl).toBe('-4.35000000');

    const invariant = Number(latestSnapshot.rows[0].portfolio_equity)
      - (50000 + Number(latestSnapshot.rows[0].realized_pnl));
    expect(invariant).toBeCloseTo(0, 8);
  });

  it.skipIf(SKIP)('POST execute can recover after app restart from a transient broker submission error', async () => {
    mockEngineSequence('PASS', 'PASS');
    vi.mocked(submitOrder)
      .mockRejectedValueOnce(new Error('paper broker unavailable'))
      .mockResolvedValueOnce({
        broker_order_id: 'broker-order-recovery-1',
        status: 'FILLED',
        fills: [
          {
            order_id: 'broker-order-recovery-1',
            fill_id: 'broker-fill-recovery-1',
            quantity: '15.00000000',
            price: '102.00000000',
            fee: '1.00000000',
            is_partial: false,
            filled_at: '2024-01-15T10:31:00.000Z',
          },
        ],
      });

    const created = await request(app)
      .post('/signals')
      .set('Authorization', `Bearer ${token()}`)
      .send({
        strategyId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '15.00000000',
        reason: 'phase 10 recovery test',
      });
    const failed = await request(app)
      .post(`/trade-proposals/${created.body.proposal.id}/approve`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-approve-4' });

    const restartedApp = createApp();
    const recovered = await request(restartedApp)
      .post(`/trade-proposals/${failed.body.proposal.id}/execute`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ requestId: 'phase-10-execute-4-retry' });

    expect(failed.status).toBe(503);
    expect(failed.body.proposal.status).toBe('EXECUTION_ERROR');
    expect(recovered.status).toBe(200);
    expect(recovered.body.proposal.status).toBe('FILLED');
    expect(recovered.body.execution.id).toBe(failed.body.execution.id);
    expect(vi.mocked(submitOrder)).toHaveBeenCalledTimes(2);
  });

  it.skipIf(SKIP)('getDayStartEquity uses the latest snapshot strictly before today, not a same-day one', async () => {
    await resetTradingLedger(pool);

    const fallback = await getDayStartEquity(pool, new Date(), '50000');
    expect(fallback.toFixed(8)).toBe('50000.00000000');

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO portfolio_snapshots
         (cash_balance, portfolio_equity, open_positions, pending_orders,
          realized_pnl, unrealized_pnl, daily_pnl, snapshot_reason, created_at)
       VALUES ($1, $2, '[]'::jsonb, '[]'::jsonb, $3, '0.00000000', $3, 'TEST_PRIOR_DAY', $4)`,
      ['49500.00000000', '49500.00000000', '-500.00000000', twoDaysAgo],
    );
    await pool.query(
      `INSERT INTO portfolio_snapshots
         (cash_balance, portfolio_equity, open_positions, pending_orders,
          realized_pnl, unrealized_pnl, daily_pnl, snapshot_reason)
       VALUES ($1, $2, '[]'::jsonb, '[]'::jsonb, $3, '0.00000000', $3, 'TEST_TODAY')`,
      ['51000.00000000', '51000.00000000', '1000.00000000'],
    );

    const dayStart = await getDayStartEquity(pool, new Date(), '50000');
    expect(dayStart.toFixed(8)).toBe('49500.00000000');

    await resetTradingLedger(pool);
  });

  it.skipIf(SKIP)('a MAX_DAILY_LOSS breach rejects the proposal and auto-disables the kill switch', async () => {
    await resetTradingLedger(pool);
    mockEngine('PASS');
    await pool.query(
      "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
    );
    await pool.query(
      `INSERT INTO portfolio_snapshots
         (cash_balance, portfolio_equity, open_positions, pending_orders,
          realized_pnl, unrealized_pnl, daily_pnl, snapshot_reason)
       VALUES ('48000.00000000', '48000.00000000', '[]'::jsonb, '[]'::jsonb,
               '-2000.00000000', '0.00000000', '-2000.00000000', 'TEST_DAILY_LOSS_BASELINE')`,
    );

    const res = await request(app)
      .post('/signals/manual-test')
      .set('Authorization', `Bearer ${token()}`)
      .set('X-Request-ID', 'daily-loss-breach')
      .send({ symbol: 'AAPL', side: 'BUY', quantity: '1.00000000' });

    expect(res.status).toBe(201);
    expect(res.body.proposal.status).toBe('RISK_REJECTED');
    expect(res.body.riskCheck.failedRules).toContain('PHASE22_MAX_DAILY_LOSS');

    const setting = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'trading_kill_switch_enabled'",
    );
    expect(setting.rows[0].value).toBe(false);

    const audit = await pool.query(
      "SELECT * FROM audit_logs WHERE event_type = 'KILL_SWITCH_AUTO_DISABLED_DAILY_LOSS' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows.length).toBe(1);

    await pool.query(
      "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
    );
    await resetTradingLedger(pool);
  });
});
