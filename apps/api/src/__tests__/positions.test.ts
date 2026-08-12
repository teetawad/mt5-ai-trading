import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
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
const OWNER_ID = '00000000-0000-4000-8000-000000009100';

function token() {
  process.env.SESSION_SECRET = 'test-secret-positions-live';
  return signToken({ sub: OWNER_ID, email: 'positions-owner@test.example.com', role: 'owner' });
}

describe('GET /positions (real-time pricing)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-positions-live';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'positions-owner@test.example.com', 'Positions Owner', 'hash', 'owner', true)
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
      // shared `positions` table (e.g. dashboard.test.ts).
      await pool.query("DELETE FROM positions WHERE symbol IN ('AAPL', 'MSFT')");
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  beforeEach(async () => {
    _clearDenylistForTest();
    vi.clearAllMocks();
    if (!SKIP) {
      // Scoped delete (not a table-wide TRUNCATE) so this doesn't collide with
      // other test files that concurrently manage their own rows in the
      // shared `positions` table (e.g. dashboard.test.ts).
      await pool.query("DELETE FROM positions WHERE symbol IN ('AAPL', 'MSFT')");
      await upsertPosition(pool, {
        symbol: 'AAPL',
        quantity: '10.00000000',
        averageEntryPrice: '150.00000000',
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        lastPrice: '150.00000000',
        lastPriceAt: new Date('2026-08-11T10:00:00.000Z'),
      });
      await upsertPosition(pool, {
        symbol: 'MSFT',
        quantity: '5.00000000',
        averageEntryPrice: '300.00000000',
        realizedPnl: '0.00000000',
        unrealizedPnl: '0.00000000',
        lastPrice: '300.00000000',
        lastPriceAt: new Date('2026-08-11T10:00:00.000Z'),
      });
    }
    vi.mocked(getPaperPortfolio).mockResolvedValue({
      cash: '47500.00000000',
      positions: { AAPL: '10.00000000', MSFT: '5.00000000' },
    });
    vi.mocked(getMarketDataStatus).mockResolvedValue({
      mode: 'stream',
      connected: true,
      last_message_at: '2026-08-11T14:30:00.000Z',
    });
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      {
        symbol: 'AAPL',
        price: '160.00000000',
        bid: '159.95000000',
        ask: '160.05000000',
        volume: 1000,
        timestamp: '2026-08-11T14:30:00.000Z',
        is_stale: false,
      },
      {
        symbol: 'MSFT',
        price: '290.00000000',
        bid: '289.90000000',
        ask: '290.10000000',
        volume: 800,
        timestamp: '2026-08-11T14:30:00.000Z',
        is_stale: false,
      },
    ]);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/positions');
    expect(res.status).toBe(401);
  });

  it.skipIf(SKIP)('prices a position up and reflects an increased unrealized P&L', async () => {
    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const aapl = res.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(aapl.lastPrice).toBe('160.00000000');
    // (160 - 150) * 10 = 100 — priced up from the stale stored 150.
    expect(aapl.unrealizedPnl).toBe('100.00000000');
    expect(aapl.isStale).toBe(false);
  });

  it.skipIf(SKIP)('prices a position down and reflects a decreased unrealized P&L', async () => {
    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const msft = res.body.positions.find((p: { symbol: string }) => p.symbol === 'MSFT');
    expect(msft.lastPrice).toBe('290.00000000');
    // (290 - 300) * 5 = -50 — priced down from the stale stored 300.
    expect(msft.unrealizedPnl).toBe('-50.00000000');
  });

  it.skipIf(SKIP)('updates multiple positions independently in the same response', async () => {
    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const aapl = res.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    const msft = res.body.positions.find((p: { symbol: string }) => p.symbol === 'MSFT');
    expect(aapl.unrealizedPnl).toBe('100.00000000');
    expect(msft.unrealizedPnl).toBe('-50.00000000');
    expect(aapl.realizedPnl).toBe('0.00000000');
    expect(msft.realizedPnl).toBe('0.00000000');
  });

  it.skipIf(SKIP)('shows DISCONNECTED status and falls back to last known prices when the stream is down', async () => {
    vi.mocked(getMarketDataStatus).mockResolvedValueOnce({
      mode: 'stream',
      connected: false,
      last_message_at: '2026-08-11T13:00:00.000Z',
    });
    vi.mocked(getAllMarketSnapshots).mockRejectedValueOnce(new Error('stream disconnected'));

    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.marketDataStatus.connected).toBe(false);
    const aapl = res.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(aapl.lastPrice).toBe('150.00000000');
    expect(aapl.isStale).toBe(true);
  });

  it.skipIf(SKIP)('reconnects and fetches a fresh snapshot on the next request', async () => {
    vi.mocked(getAllMarketSnapshots).mockRejectedValueOnce(new Error('stream disconnected'));
    const disconnected = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);
    const disconnectedAapl = disconnected.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(disconnectedAapl.isStale).toBe(true);

    const reconnected = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);
    const reconnectedAapl = reconnected.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(reconnectedAapl.isStale).toBe(false);
    expect(reconnectedAapl.lastPrice).toBe('160.00000000');
  });

  it.skipIf(SKIP)('flags a position stale when its own market snapshot reports is_stale', async () => {
    vi.mocked(getAllMarketSnapshots).mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        price: '160.00000000',
        bid: '159.95000000',
        ask: '160.05000000',
        volume: 1000,
        timestamp: '2026-08-11T09:00:00.000Z',
        is_stale: true,
      },
      {
        symbol: 'MSFT',
        price: '290.00000000',
        bid: '289.90000000',
        ask: '290.10000000',
        volume: 800,
        timestamp: '2026-08-11T14:30:00.000Z',
        is_stale: false,
      },
    ]);

    const res = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    const aapl = res.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    const msft = res.body.positions.find((p: { symbol: string }) => p.symbol === 'MSFT');
    expect(aapl.isStale).toBe(true);
    expect(msft.isStale).toBe(false);
  });

  it.skipIf(SKIP)('does not change realized P&L when only the live price ticks', async () => {
    const first = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);
    vi.mocked(getAllMarketSnapshots).mockResolvedValueOnce([
      {
        symbol: 'AAPL',
        price: '999.99000000',
        bid: '999.90000000',
        ask: '1000.05000000',
        volume: 1000,
        timestamp: '2026-08-11T14:31:00.000Z',
        is_stale: false,
      },
      {
        symbol: 'MSFT',
        price: '290.00000000',
        bid: '289.90000000',
        ask: '290.10000000',
        volume: 800,
        timestamp: '2026-08-11T14:31:00.000Z',
        is_stale: false,
      },
    ]);
    const second = await request(app).get('/positions').set('Authorization', `Bearer ${token()}`);

    const firstAapl = first.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    const secondAapl = second.body.positions.find((p: { symbol: string }) => p.symbol === 'AAPL');
    expect(firstAapl.realizedPnl).toBe('0.00000000');
    expect(secondAapl.realizedPnl).toBe('0.00000000');
    expect(firstAapl.unrealizedPnl).not.toBe(secondAapl.unrealizedPnl);
  });
});
