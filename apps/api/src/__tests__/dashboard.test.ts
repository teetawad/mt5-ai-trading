import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { createSnapshot } from '../db/repositories/portfolio-snapshots';
import { upsertPosition } from '../db/repositories/positions';
import { getTestPool, setupTestDb } from './db/setup';
import {
  getAllMarketSnapshots,
  getBrokerOpenOrders,
  getBrokerHealth,
  getMarketDataStatus,
  getPaperAccount,
  getPaperPortfolio,
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
    getMarketDataStatus: vi.fn(),
    getPaperAccount: vi.fn(),
    getPaperPortfolio: vi.fn(),
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
      await pool.query('TRUNCATE portfolio_snapshots RESTART IDENTITY CASCADE');
      // Scoped delete (not a table-wide TRUNCATE) so this doesn't collide with
      // other test files that concurrently manage their own rows in the
      // shared `positions` table (e.g. positions.test.ts).
      await pool.query("DELETE FROM positions WHERE symbol = 'NVDA'");
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
    delete process.env.BROKER_PROVIDER;
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    if (!SKIP) {
      await pool.query('TRUNCATE portfolio_snapshots RESTART IDENTITY CASCADE');
      // Scoped delete (not a table-wide TRUNCATE) so this doesn't collide with
      // other test files that concurrently manage their own rows in the
      // shared `positions` table (e.g. positions.test.ts).
      await pool.query("DELETE FROM positions WHERE symbol = 'NVDA'");
      // trading_kill_switch_enabled is a single global row shared by the whole
      // test database; another suite's MAX_DAILY_LOSS circuit breaker (Milestone
      // 1b) can legitimately flip it, so pin a known value for this assertion.
      await pool.query(
        "UPDATE system_settings SET value = 'true'::jsonb WHERE key = 'trading_kill_switch_enabled'",
      );
      await createSnapshot(pool, {
        cashBalance: '50000.25000000',
        portfolioEquity: '50000.25000000',
        openPositions: [],
        pendingOrders: [],
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        dailyPnl: '0.00000000',
        snapshotReason: 'TEST_DASHBOARD',
      });
    }
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
    vi.mocked(getMarketDataStatus).mockResolvedValue({
      mode: 'stream',
      connected: true,
      last_message_at: '2026-08-11T14:30:00.000Z',
    });
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '50000.25000000',
      positions: {},
    });
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
      source: 'ALPACA_PAPER_ACCOUNT',
      provider: 'alpaca_paper',
      tradingMode: 'PAPER',
      status: 'CONNECTED',
      accountStatus: 'CONNECTED',
      cash: '50000.25000000',
      buyingPower: '75000.00000000',
    });
    expect(res.body.portfolio).toMatchObject({
      source: 'INTERNAL_LEDGER',
      cashBalance: '50000.25000000',
      portfolioEquity: '50000.25000000',
    });
    expect(res.body.marketData.status).toBe('CONNECTED');
    expect(res.body.marketData.freshness).toBe('FRESH');
    expect(res.body.marketData.snapshots[0]).toMatchObject({
      symbol: 'AAPL',
      price: '191.25000000',
      isStale: false,
    });
    expect(res.body.reconciliation).toMatchObject({
      status: 'MATCH',
      brokerCash: '50000.25000000',
      internalCash: '50000.25000000',
      cashDifference: '0.00000000',
      sourceOfTruth: 'INTERNAL_LEDGER',
      comparedSource: 'ALPACA_PAPER_ACCOUNT',
    });
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

  it.skipIf(SKIP)('marks reconciliation mismatch when Alpaca Paper cash differs from internal ledger cash', async () => {
    await pool.query('TRUNCATE portfolio_snapshots RESTART IDENTITY CASCADE');
    await createSnapshot(pool, {
      cashBalance: '99997.72000000',
      portfolioEquity: '99997.72000000',
      openPositions: [],
      pendingOrders: [],
      realizedPnl: '-2.28000000',
      unrealizedPnl: '0.00000000',
      dailyPnl: '-2.28000000',
      snapshotReason: 'TEST_DASHBOARD_MISMATCH',
    });
    vi.mocked(getPaperAccount).mockResolvedValueOnce({
      cash: '100000.00000000',
      buying_power: '100000.00000000',
      account_id: 'paper-account-1',
      currency: 'USD',
      status: 'ACTIVE',
    });
    // Internal ledger's live cash (from the paper broker), independent of the
    // Alpaca account cash above — that gap is exactly what creates the mismatch.
    vi.mocked(getPaperPortfolio).mockResolvedValueOnce({
      cash: '99997.72000000',
      positions: {},
    });

    const res = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.broker.cash).toBe('100000.00000000');
    expect(res.body.portfolio.cashBalance).toBe('99997.72000000');
    expect(res.body.reconciliation).toMatchObject({
      status: 'MISMATCH',
      brokerCash: '100000.00000000',
      internalCash: '99997.72000000',
      internalEquity: '99997.72000000',
      cashDifference: '2.28000000',
    });
  });

  it.skipIf(SKIP)('recomputes unrealized P&L and portfolio equity live from the current market price', async () => {
    await upsertPosition(pool, {
      symbol: 'NVDA',
      quantity: '10.00000000',
      averageEntryPrice: '150.00000000',
      realizedPnl: '0.00000000',
      unrealizedPnl: '0.00000000',
      lastPrice: '150.00000000',
      lastPriceAt: new Date('2026-08-11T10:00:00.000Z'),
    });
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '48500.00000000',
      positions: { NVDA: '10.00000000' },
    });
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      {
        symbol: 'NVDA',
        price: '191.25000000',
        bid: '191.20000000',
        ask: '191.30000000',
        volume: 1000,
        timestamp: '2026-08-11T14:30:00.000Z',
        is_stale: false,
      },
    ]);

    const res = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const position = res.body.positions.find((p: { symbol: string }) => p.symbol === 'NVDA');
    expect(position.lastPrice).toBe('191.25000000');
    // (191.25 - 150.00) * 10 = 412.50 — live price, not the stale stored 150.00.
    expect(position.unrealizedPnl).toBe('412.50000000');
    expect(position.isStale).toBe(false);
    expect(res.body.portfolio.unrealizedPnl).toBe('412.50000000');
  });

  it.skipIf(SKIP)('flags a position as stale when its market snapshot reports is_stale', async () => {
    await upsertPosition(pool, {
      symbol: 'NVDA',
      quantity: '10.00000000',
      averageEntryPrice: '150.00000000',
      realizedPnl: '0.00000000',
      unrealizedPnl: '0.00000000',
      lastPrice: '150.00000000',
      lastPriceAt: new Date('2026-08-11T10:00:00.000Z'),
    });
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '48500.00000000',
      positions: { NVDA: '10.00000000' },
    });
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      {
        symbol: 'NVDA',
        price: '191.25000000',
        bid: '191.20000000',
        ask: '191.30000000',
        volume: 1000,
        timestamp: '2026-08-11T09:00:00.000Z',
        is_stale: true,
      },
    ]);

    const res = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const position = res.body.positions.find((p: { symbol: string }) => p.symbol === 'NVDA');
    expect(position.isStale).toBe(true);
    expect(res.body.marketData.freshness).toBe('STALE');
  });

  it.skipIf(SKIP)('reflects the market-data stream reconnecting across two requests', async () => {
    vi.mocked(getMarketDataStatus).mockResolvedValueOnce({
      mode: 'stream',
      connected: false,
      last_message_at: '2026-08-11T13:00:00.000Z',
    });

    const disconnected = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);
    expect(disconnected.body.marketData.streamMode).toBe('stream');
    expect(disconnected.body.marketData.streamConnected).toBe(false);

    vi.mocked(getMarketDataStatus).mockResolvedValueOnce({
      mode: 'stream',
      connected: true,
      last_message_at: '2026-08-11T14:35:00.000Z',
    });

    const reconnected = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);
    expect(reconnected.body.marketData.streamConnected).toBe(true);
    expect(reconnected.body.marketData.streamLastMessageAt).toBe('2026-08-11T14:35:00.000Z');
  });

  it.skipIf(SKIP)('does not fail the dashboard request when the market-data status call itself errors', async () => {
    vi.mocked(getMarketDataStatus).mockRejectedValueOnce(new Error('trading engine unreachable'));

    const res = await request(app)
      .get('/dashboard/paper')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.marketData.streamConnected).toBe(false);
  });
});
