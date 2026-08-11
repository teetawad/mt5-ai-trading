import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { createStrategy } from '../db/repositories/strategies';
import { getTestPool, setupTestDb } from './db/setup';
import {
  evaluateRisk,
  getMarketSnapshot,
  getPaperPortfolio,
} from '../services/trading-engine-client';

vi.mock('../services/trading-engine-client', async () => {
  const actual = await vi.importActual<typeof import('../services/trading-engine-client')>(
    '../services/trading-engine-client',
  );
  return {
    ...actual,
    getMarketSnapshot: vi.fn(),
    getPaperPortfolio: vi.fn(),
    evaluateRisk: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000080';

function token() {
  process.env.SESSION_SECRET = 'test-secret-phase-8';
  return signToken({ sub: OWNER_ID, email: 'phase8-owner@test.example.com', role: 'owner' });
}

function riskResult(result: 'PASS' | 'REJECT', failedRules: string[] = []) {
  return {
    result,
    stage: 'PRE_PROPOSAL' as const,
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
  vi.mocked(evaluateRisk).mockResolvedValue(
    result === 'PASS' ? riskResult('PASS') : riskResult('REJECT', ['MAX_ORDER_NOTIONAL']),
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

  it('GET /trade-proposals requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/trade-proposals');
    expect(res.status).toBe(401);
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
      await pool.query('DELETE FROM audit_logs WHERE actor_id = $1', [OWNER_ID]);
      await pool.query("DELETE FROM trade_proposals WHERE symbol IN ('AAPL')");
      await pool.query("DELETE FROM risk_checks WHERE market_snapshot->>'symbol' = 'AAPL'");
      await pool.query("DELETE FROM signals WHERE symbol = 'AAPL'");
      await pool.query("DELETE FROM strategies WHERE name LIKE 'phase-8-%'");
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
});
