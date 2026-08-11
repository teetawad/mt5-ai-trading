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
import { approveProposal } from '../services/trade-proposal-service';
import {
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
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(() => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    mockEngine('PASS');
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
});
