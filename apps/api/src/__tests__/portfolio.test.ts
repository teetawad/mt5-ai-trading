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
  getMarketDataStatus,
  getPaperPortfolio,
} from '../services/trading-engine-client';

vi.mock('../services/trading-engine-client', async () => {
  const actual = await vi.importActual<typeof import('../services/trading-engine-client')>(
    '../services/trading-engine-client',
  );
  return {
    ...actual,
    getAllMarketSnapshots: vi.fn(),
    getMarketDataStatus: vi.fn(),
    getPaperPortfolio: vi.fn(),
  };
});

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000009200';

function token() {
  process.env.SESSION_SECRET = 'test-secret-portfolio-live';
  return signToken({ sub: OWNER_ID, email: 'portfolio-owner@test.example.com', role: 'owner' });
}

function snapshot(symbol: string, price: string) {
  return {
    symbol,
    price,
    bid: price,
    ask: price,
    volume: 1000,
    timestamp: '2026-08-12T10:00:00.000Z',
    is_stale: false,
  };
}

// Mirrors a real reported mismatch: GOOGL/META/QQQ live unrealized P&L sums
// to -11.97, while a portfolio_snapshots row persisted at the last trade
// execution (before the price ticks below) is stuck at -3.00.
describe('GET /portfolio (live source of truth)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-portfolio-live';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'portfolio-owner@test.example.com', 'Portfolio Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      // Scoped delete (not a table-wide TRUNCATE) so this doesn't collide with
      // other test files that concurrently manage their own rows in the
      // shared `positions` table (e.g. positions.test.ts, dashboard.test.ts).
      await pool.query("DELETE FROM positions WHERE symbol IN ('GOOGL', 'META', 'QQQ')");
      await pool.query('TRUNCATE portfolio_snapshots RESTART IDENTITY CASCADE');
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    if (!SKIP) {
      await pool.query("DELETE FROM positions WHERE symbol IN ('GOOGL', 'META', 'QQQ')");
      await pool.query('TRUNCATE portfolio_snapshots RESTART IDENTITY CASCADE');
      await upsertPosition(pool, {
        symbol: 'GOOGL',
        quantity: '10.00000000',
        averageEntryPrice: '100.00000000',
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        lastPrice: '100.00000000',
        lastPriceAt: new Date('2026-08-12T09:00:00.000Z'),
      });
      await upsertPosition(pool, {
        symbol: 'META',
        quantity: '5.00000000',
        averageEntryPrice: '200.00000000',
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        lastPrice: '200.00000000',
        lastPriceAt: new Date('2026-08-12T09:00:00.000Z'),
      });
      await upsertPosition(pool, {
        symbol: 'QQQ',
        quantity: '2.00000000',
        averageEntryPrice: '300.00000000',
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        lastPrice: '300.00000000',
        lastPriceAt: new Date('2026-08-12T09:00:00.000Z'),
      });
      // Simulates the reported bug: a snapshot persisted at the last trade
      // execution, now stale relative to the live prices mocked below.
      await createSnapshot(pool, {
        cashBalance: '48500.00000000',
        portfolioEquity: '99997.00000000',
        openPositions: [],
        pendingOrders: [],
        realizedPnl: '0.00000000',
        unrealizedPnl: '-3.00000000',
        dailyPnl: '-3.00000000',
        snapshotReason: 'TEST_STALE_TRADE_EXECUTION',
      });
    }
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '48500.00000000',
      positions: { GOOGL: '10.00000000', META: '5.00000000', QQQ: '2.00000000' },
    });
    vi.mocked(getMarketDataStatus).mockResolvedValue({
      mode: 'stream',
      connected: true,
      last_message_at: '2026-08-12T10:00:00.000Z',
    });
    // (99.715-100)*10 + (199.254-200)*5 + (297.305-300)*2 = -2.85 -3.73 -5.39 = -11.97
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      snapshot('GOOGL', '99.71500000'),
      snapshot('META', '199.25400000'),
      snapshot('QQQ', '297.30500000'),
    ]);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/portfolio');
    expect(res.status).toBe(401);
  });

  it.skipIf(SKIP)('reports live unrealized P&L instead of the stale persisted snapshot', async () => {
    const res = await request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.unrealizedPnl).toBe('-11.97000000');
    expect(res.body.unrealizedPnl).not.toBe('-3.00000000');
  });

  it.skipIf(SKIP)('sum of live position unrealized P&L equals the portfolio unrealized P&L', async () => {
    const [portfolioRes, positionsRes] = await Promise.all([
      request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`),
      request(app).get('/positions').set('Authorization', `Bearer ${token()}`),
    ]);

    expect(positionsRes.body.positions).toHaveLength(3);
    const sum = positionsRes.body.positions.reduce(
      (total: number, position: { unrealizedPnl: string }) => total + Number(position.unrealizedPnl),
      0,
    );

    expect(portfolioRes.body.unrealizedPnl).toBe('-11.97000000');
    expect(sum).toBeCloseTo(Number(portfolioRes.body.unrealizedPnl), 8);
  });

  it.skipIf(SKIP)('GET /positions returns a server-computed marketValue that matches quantity * live price', async () => {
    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const googl = res.body.positions.find((p: { symbol: string }) => p.symbol === 'GOOGL');
    // 10 * 99.715 = 997.15
    expect(googl.marketValue).toBe('997.15000000');
  });

  it.skipIf(SKIP)('portfolio equity is cash plus the live market value of open positions', async () => {
    const res = await request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`);

    // 48500 + (99.715*10 + 199.254*5 + 297.305*2) = 48500 + 2588.03
    expect(res.body.portfolioEquity).toBe('51088.03000000');
  });

  it.skipIf(SKIP)('realized P&L does not change when only live prices move', async () => {
    const first = await request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`);
    vi.mocked(getAllMarketSnapshots).mockResolvedValueOnce([
      snapshot('GOOGL', '150.00000000'),
      snapshot('META', '250.00000000'),
      snapshot('QQQ', '350.00000000'),
    ]);
    const second = await request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`);

    expect(second.body.realizedPnl).toBe(first.body.realizedPnl);
    expect(second.body.unrealizedPnl).not.toBe(first.body.unrealizedPnl);
  });

  it.skipIf(SKIP)('historical snapshots stay historical and are not overwritten by live pricing', async () => {
    await request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`);

    const res = await request(app)
      .get('/portfolio/snapshots?limit=10')
      .set('Authorization', `Bearer ${token()}`);
    const stale = res.body.snapshots.find(
      (row: { snapshotReason: string }) => row.snapshotReason === 'TEST_STALE_TRADE_EXECUTION',
    );

    expect(stale).toBeDefined();
    expect(stale.unrealizedPnl).toBe('-3.00000000');
  });

  it.skipIf(SKIP)('GET /portfolio/pnl agrees with GET /portfolio', async () => {
    const [portfolioRes, pnlRes] = await Promise.all([
      request(app).get('/portfolio').set('Authorization', `Bearer ${token()}`),
      request(app).get('/portfolio/pnl').set('Authorization', `Bearer ${token()}`),
    ]);

    expect(pnlRes.body.unrealizedPnl).toBe(portfolioRes.body.unrealizedPnl);
    expect(pnlRes.body.realizedPnl).toBe(portfolioRes.body.realizedPnl);
    expect(pnlRes.body.dailyPnl).toBe(portfolioRes.body.dailyPnl);
  });
});
