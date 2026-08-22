import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, setupTestDb } from './db/setup';
import { getTopOpportunities } from '../services/trading-ai/opportunity-scan';

const SKIP = !process.env.TEST_DATABASE_URL;

// Regression test for the GET /mt5/ai-trade/top-opportunities 503: the real
// query previously bound `limit` as an unused $1 SQL parameter — the query
// text never referenced $1 anywhere (only $2/maxAgeHours), so Postgres
// rejected every call with "could not determine data type of parameter $1"
// (mislabeled at the route as a generic MT5_BACKEND_ERROR, even though this
// endpoint never touches MT5). This test drives the REAL query against a
// real Postgres test database — the previous mocked-module tests
// (mt5-scan-route-order.test.ts) never actually executed this SQL, which is
// exactly how the bug went unnoticed.
describe.skipIf(SKIP)('getTopOpportunities', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestDb(pool);
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM watchlists WHERE symbol LIKE 'TESTTOPOPP%'`);
    await pool.query(`DELETE FROM ai_analysis_runs WHERE symbol LIKE 'TESTTOPOPP%'`);
    await pool.query(`DELETE FROM instruments WHERE symbol LIKE 'TESTTOPOPP%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertInstrument(symbol: string, assetClass = 'FOREX') {
    await pool.query(
      `INSERT INTO instruments(symbol, broker_symbol, asset_class) VALUES($1,$1,$2)
       ON CONFLICT (symbol) DO UPDATE SET asset_class = EXCLUDED.asset_class`,
      [symbol, assetClass],
    );
  }

  async function insertWatchlist(symbol: string) {
    await pool.query(
      `INSERT INTO watchlists(symbol, enabled) VALUES($1, true) ON CONFLICT (name, symbol) DO UPDATE SET enabled = true`,
      [symbol],
    );
  }

  async function insertAnalysisRun(symbol: string, overrides: { decision?: string; tradeabilityPct?: number; createdAt?: string } = {}) {
    await pool.query(
      `INSERT INTO ai_analysis_runs(
         symbol, asset_class, ai_provider, ai_model, ai_prompt_version, market_analysis_package,
         decision, confidence_pct, tradeability_pct, profitability_score, action, action_reason, created_at)
       VALUES($1,'FOREX','openai','gpt-test','TEST','{}'::jsonb,$2,70,$3,70,'WAIT_FOR_ENTRY','PENDING_ENTRY_PLAN_READY',$4)`,
      [symbol, overrides.decision ?? 'BUY', overrides.tradeabilityPct ?? 70, overrides.createdAt ?? new Date().toISOString()],
    );
  }

  it('runs the real query without a Postgres parameter-type error and returns the row', async () => {
    await insertInstrument('TESTTOPOPP1');
    await insertWatchlist('TESTTOPOPP1');
    await insertAnalysisRun('TESTTOPOPP1');

    // The regression threw synchronously inside pool.query — this call not
    // throwing at all is the core assertion.
    const result = await getTopOpportunities(pool, 3, 12);

    expect(result.find((r) => r.symbol === 'TESTTOPOPP1')).toBeDefined();
  });

  it('respects the requested limit (applied in-memory, never as an unused SQL parameter)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertInstrument(`TESTTOPOPPLIM${i}`);
      await insertWatchlist(`TESTTOPOPPLIM${i}`);
      await insertAnalysisRun(`TESTTOPOPPLIM${i}`, { tradeabilityPct: 50 + i });
    }
    const result = await getTopOpportunities(pool, 2, 12);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('excludes analysis older than maxAgeHours', async () => {
    await insertInstrument('TESTTOPOPPOLD');
    await insertWatchlist('TESTTOPOPPOLD');
    await insertAnalysisRun('TESTTOPOPPOLD', { createdAt: new Date(Date.now() - 48 * 3600_000).toISOString() });

    const result = await getTopOpportunities(pool, 3, 12);
    expect(result.find((r) => r.symbol === 'TESTTOPOPPOLD')).toBeUndefined();
  });

  it('excludes a symbol not on an enabled watchlist', async () => {
    await insertInstrument('TESTTOPOPPNOTWATCHED');
    await insertAnalysisRun('TESTTOPOPPNOTWATCHED');

    const result = await getTopOpportunities(pool, 3, 12);
    expect(result.find((r) => r.symbol === 'TESTTOPOPPNOTWATCHED')).toBeUndefined();
  });
});
