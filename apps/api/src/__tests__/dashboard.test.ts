import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { getTestPool, setupTestDb } from './db/setup';
import {
  getAllMarketSnapshots,
  getBrokerOpenOrders,
  getBrokerHealth,
  getPaperAccount,
} from '../services/trading-engine-client';

vi.mock('../services/trading-engine-client', async () => {
  const actual = await vi.importActual<typeof import('../services/trading-engine-client')>(
    '../services/trading-engine-client',
  );
  return {
    ...actual,
    getAllMarketSnapshots: vi.fn(),
    getBrokerOpenOrders: vi.fn(),
    getBrokerHealth: vi.fn(),
    getPaperAccount: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000001650';

function token() {
  process.env.SESSION_SECRET = 'test-secret-phase-16-5';
  return signToken({ sub: OWNER_ID, email: 'phase16-5-owner@test.example.com', role: 'owner' });
}

describe('GET /dashboard/paper', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-phase-16-5';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.BROKER_PROVIDER = 'alpaca_paper';
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'phase16-5-owner@test.example.com', 'Phase 16.5 Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
    delete process.env.BROKER_PROVIDER;
  });

  beforeEach(() => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    vi.mocked(getBrokerHealth).mockResolvedValue({
      available: true,
      provider: 'alpaca_paper',
      trading_mode: 'PAPER',
    });
    vi.mocked(getPaperAccount).mockResolvedValue({
      cash: '50000.25000000',
      buying_power: '75000.00000000',
      account_id: 'paper-account-1',
      currency: 'USD',
      status: 'ACTIVE',
    });
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      {
        symbol: 'AAPL',
        price: '191.25000000',
        bid: '191.20000000',
        ask: '191.30000000',
        volume: 1000,
        timestamp: '2026-08-11T14:30:00.000Z',
        is_stale: false,
      },
    ]);
    vi.mocked(getBrokerOpenOrders).mockResolvedValue([
      {
        broker_order_id: 'alpaca-paper-open-1',
        status: 'SUBMITTED',
        fills: [],
      },
    ]);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/dashboard/paper');
    expect(res.status).toBe(401);
  });

  it.skipIf(SKIP)('returns the paper trading dashboard aggregation', async () => {
    const res = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.tradingMode).toBe('PAPER');
    expect(res.body.paperTrading).toBe(true);
    expect(res.body.broker).toMatchObject({
      provider: 'alpaca_paper',
      tradingMode: 'PAPER',
      status: 'CONNECTED',
      accountStatus: 'CONNECTED',
      cash: '50000.25000000',
      buyingPower: '75000.00000000',
    });
    expect(res.body.marketData.status).toBe('CONNECTED');
    expect(res.body.marketData.freshness).toBe('FRESH');
    expect(res.body.marketData.snapshots[0]).toMatchObject({
      symbol: 'AAPL',
      price: '191.25000000',
      isStale: false,
    });
    expect(res.body.reconciliation.status).toBe('CONNECTED');
    expect(res.body.killSwitch.enabled).toBe(true);
    expect(Array.isArray(res.body.pendingProposals)).toBe(true);
    expect(Array.isArray(res.body.riskResults)).toBe(true);
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.brokerOpenOrders[0]).toMatchObject({
      broker_order_id: 'alpaca-paper-open-1',
      status: 'SUBMITTED',
    });
    expect(Array.isArray(res.body.fills)).toBe(true);
    expect(Array.isArray(res.body.positions)).toBe(true);
  });
});
