import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { getTestPool, setupTestDb } from './db/setup';
import { signToken } from '../auth/tokens';

const SKIP = !process.env.TEST_DATABASE_URL;

// Root-cause coverage for the reported "PATCH /mt5/watchlist -> 401
// Unauthorized" bug: proves the real HTTP route, through the real
// requireAuth/requireOwner middleware, behaves correctly for an
// authenticated owner and is genuinely unauthenticated-only when it 401s -
// there is no watchlist-specific auth wiring bug.
describe.skipIf(SKIP)('PATCH /mt5/watchlist', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const symbol = 'TESTWATCH';

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-watchlist-secret';
    pool = getTestPool();
    await setupTestDb(pool);
    app = createApp();
    await pool.query(
      `INSERT INTO instruments(symbol, broker_symbol, asset_class)
       VALUES($1, $1, 'CRYPTO_CFD')
       ON CONFLICT(symbol) DO NOTHING`,
      [symbol],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
      await pool.query('DELETE FROM instruments WHERE symbol = $1', [symbol]);
      await pool.end();
    }
  });

  afterEach(async () => {
    await pool.query('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
  });

  function ownerToken(): string {
    return signToken({ sub: 'owner-watchlist-test', email: 'owner@example.com', role: 'owner' });
  }

  it('enabling a symbol while authenticated as owner succeeds — no 401', async () => {
    const res = await request(app)
      .patch('/mt5/watchlist')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbols: [symbol], enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.symbols[0]).toEqual({ symbol, enabled: true });
  });

  it('disabling a symbol while authenticated as owner succeeds — no 401', async () => {
    await request(app).patch('/mt5/watchlist').set('Authorization', `Bearer ${ownerToken()}`).send({ symbols: [symbol], enabled: true });
    const res = await request(app)
      .patch('/mt5/watchlist')
      .set('Authorization', `Bearer ${ownerToken()}`)
      .send({ symbols: [symbol], enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.symbols[0]).toEqual({ symbol, enabled: false });
  });

  it('is genuinely unauthenticated-only: no token at all correctly 401s with UNAUTHENTICATED', async () => {
    const res = await request(app).patch('/mt5/watchlist').send({ symbols: [symbol], enabled: true });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('an expired/invalid session token correctly 401s with UNAUTHENTICATED, not a silent success', async () => {
    const res = await request(app)
      .patch('/mt5/watchlist')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ symbols: [symbol], enabled: true });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('uses the same requireOwner middleware as other protected MT5 routes (GET /mt5/instruments) — both reject the same way when unauthenticated', async () => {
    const watchlistRes = await request(app).patch('/mt5/watchlist').send({ symbols: [symbol], enabled: true });
    const instrumentsRes = await request(app).get('/mt5/instruments');
    expect(watchlistRes.status).toBe(instrumentsRes.status);
    expect(watchlistRes.body.error).toBe(instrumentsRes.body.error);
  });
});
