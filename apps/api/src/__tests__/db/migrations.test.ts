import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './setup';

const SKIP = !process.env.TEST_DATABASE_URL;

describe('migrations', () => {
  let pool: Pool;

  beforeAll(async () => {
    if (SKIP) return;
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it.skipIf(SKIP)('applies all migrations idempotently', async () => {
    // Run a second time — must not throw
    await setupTestDb(pool);

    const { rows } = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows[0].version).toBe('0001_create_users');
    expect(rows[rows.length - 1].version).toBe('0018_seed_phase22_risk_settings');
  });

  it.skipIf(SKIP)('all expected tables exist', async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    );
    const tables = rows.map((r) => r.tablename);
    const expected = [
      'audit_logs',
      'executions',
      'fills',
      'orders',
      'portfolio_snapshots',
      'positions',
      'risk_checks',
      'schema_migrations',
      'signals',
      'strategies',
      'system_settings',
      'trade_approvals',
      'trade_proposals',
      'users',
    ];
    for (const t of expected) {
      expect(tables).toContain(t);
    }
  });

  it.skipIf(SKIP)('system_settings seeded with defaults', async () => {
    const { rows } = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'trading_mode'",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('PAPER');
  });
});
