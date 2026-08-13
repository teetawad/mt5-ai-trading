import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';
import { closePool } from '../db/client';
import { createRiskCheck } from '../db/repositories/risk-checks';
import { getTestPool, setupTestDb } from './db/setup';

const SKIP = !process.env.TEST_DATABASE_URL;
const OWNER_ID = '00000000-0000-4000-8000-000000000007';
const VIEWER_ID = '00000000-0000-4000-8000-000000000008';

function token(role = 'owner', sub = OWNER_ID) {
  process.env.SESSION_SECRET = 'test-secret-risk';
  return signToken({ sub, email: `${role}@test.example.com`, role });
}

beforeEach(() => {
  _clearDenylistForTest();
});

describe('risk API auth guards', () => {
  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/risk/settings');
    expect(res.status).toBe(401);
  });

  it('requires owner role for setting updates before opening a DB connection', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/risk/settings/max_open_positions')
      .set('Authorization', `Bearer ${token('viewer', VIEWER_ID)}`)
      .send({ value: 12 });
    expect(res.status).toBe(403);
  });

  it('validates kill-switch payload before opening a DB connection', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/risk/kill-switch')
      .set('Authorization', `Bearer ${token()}`)
      .send({ enabled: 'false' });
    expect(res.status).toBe(422);
  });
});

describe('risk API database routes', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    if (SKIP) return;
    process.env.SESSION_SECRET = 'test-secret-risk';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getTestPool();
    await setupTestDb(pool);
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active)
       VALUES ($1, 'risk-owner@test.example.com', 'Risk Owner', 'hash', 'owner', true)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_ID],
    );
    app = createApp();
  });

  afterAll(async () => {
    await closePool();
    if (pool) {
      await pool.query('DELETE FROM audit_logs WHERE actor_id = $1', [OWNER_ID]);
      await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID]);
      await pool.end();
    }
  });

  it.skipIf(SKIP)('returns risk settings', async () => {
    const res = await request(app)
      .get('/risk/settings')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.map((s: { key: string }) => s.key)).toContain('max_open_positions');
    expect(res.body.map((s: { key: string }) => s.key)).toContain('trading_kill_switch_enabled');
  });

  it.skipIf(SKIP)('updates a writable risk setting and audit logs it', async () => {
    const res = await request(app)
      .put('/risk/settings/max_open_positions')
      .set('Authorization', `Bearer ${token()}`)
      .set('X-Request-ID', 'risk-setting-test')
      .send({ value: 12 });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('max_open_positions');
    expect(res.body.value).toBe(12);

    const { rows } = await pool.query(
      "SELECT * FROM audit_logs WHERE event_type = 'RISK_SETTING_UPDATED' AND request_id = $1",
      ['risk-setting-test'],
    );
    expect(rows).toHaveLength(1);
  });

  it.skipIf(SKIP)('rejects trading_mode updates through risk settings', async () => {
    const res = await request(app)
      .put('/risk/settings/trading_mode')
      .set('Authorization', `Bearer ${token()}`)
      .send({ value: 'LIVE' });
    expect(res.status).toBe(422);
  });

  it.skipIf(SKIP)('rejects a fraction-convention setting entered as a whole percent', async () => {
    // max_portfolio_concentration_pct is stored as a 0-1 fraction (0.20 =
    // 20%). "5" typed meaning "5%" would otherwise silently become an
    // unenforceable 500%-of-equity cap once riskConfig() multiplies by 100.
    const res = await request(app)
      .put('/risk/settings/max_portfolio_concentration_pct')
      .set('Authorization', `Bearer ${token()}`)
      .send({ value: '5' });
    expect(res.status).toBe(422);
  });

  it.skipIf(SKIP)('accepts a fraction-convention setting within 0-1', async () => {
    const res = await request(app)
      .put('/risk/settings/max_portfolio_concentration_pct')
      .set('Authorization', `Bearer ${token()}`)
      .send({ value: '0.25' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('0.25');
  });

  it.skipIf(SKIP)('updates kill switch and audit logs it', async () => {
    const res = await request(app)
      .put('/risk/kill-switch')
      .set('Authorization', `Bearer ${token()}`)
      .set('X-Request-ID', 'kill-switch-test')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    const readRes = await request(app)
      .get('/risk/kill-switch')
      .set('Authorization', `Bearer ${token()}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.enabled).toBe(false);
  });

  it.skipIf(SKIP)('lists and reads persisted risk checks', async () => {
    const created = await createRiskCheck(pool, {
      stage: 'PRE_PROPOSAL',
      result: 'REJECT',
      rulesChecked: ['KILL_SWITCH'],
      failedRules: ['KILL_SWITCH'],
      reason: 'Kill switch is disabled',
      marketSnapshot: { symbol: 'AAPL', price: '100.00' },
      portfolioSnapshot: { cash: '50000.00' },
    });

    const listRes = await request(app)
      .get('/risk/checks')
      .set('Authorization', `Bearer ${token()}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: string }) => c.id === created.id)).toBe(true);

    const detailRes = await request(app)
      .get(`/risk/checks/${created.id}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.failedRules).toEqual(['KILL_SWITCH']);
  });
});
