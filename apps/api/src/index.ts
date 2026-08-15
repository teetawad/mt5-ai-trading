import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// trade/.env
const envPath = path.resolve(__dirname, '../../../.env');

if (existsSync(envPath)) {
  loadEnvFile(envPath);
  console.log(`[api] Loaded environment from ${envPath}`);
}

async function main() {
  // โหลด app หลังจาก .env ถูกโหลดแล้ว
  const { app } = await import('./app');

  const PORT = Number(process.env.API_PORT) || 4000;
  const HOST = process.env.API_HOST || '0.0.0.0';

  app.listen(PORT, HOST, () => {
    console.log(`[api] Paper Trading API running at http://${HOST}:${PORT}`);
    console.log('[api] Mode: PAPER TRADING — no real-money execution');
  });

  // Restart recovery: reconcile any bracket order whose SL/TP leg filled on
  // the broker side while this process was down. Best-effort — never blocks
  // startup or crashes the process on failure.
  try {
    const { getPool } = await import('./db/client');
    const { reconcileBracketOrders } = await import('./services/trade-execution-service');
    const outcome = await reconcileBracketOrders(getPool());
    if (outcome.checked > 0) {
      console.log(
        `[api] Bracket reconciliation on startup: checked ${outcome.checked}, `
        + `reconciled ${outcome.reconciled}, errors ${outcome.errors}`,
      );
    }
  } catch (err) {
    console.error('[api] Bracket reconciliation on startup failed (non-fatal):', err);
  }

  // Phase 27 hourly scheduler: the "Hourly Scanner" that detects newly
  // closed 1H candles and evaluates each watchlist symbol exactly once.
  // Started here (not app.ts) for the same reason bracket reconciliation
  // is — this file is never imported by the test suite (tests hit `app`
  // via supertest), so the scheduler never runs during `npm test`.
  const { getPool: getPoolForScheduler } = await import('./db/client');
  const { startHourlyScheduler } = await import('./services/hourly-scheduler');
  startHourlyScheduler(getPoolForScheduler());
}

main().catch((error) => {
  console.error('[api] Failed to start:', error);
  process.exit(1);
});