import { Pool } from 'pg';
import { runAssistedAnalysis } from './mt5-demo-lab-service';

const SYSTEM_ACTOR = {
  actorId: null,
  actorEmail: 'mt5-hourly-scheduler@internal',
  requestId: 'mt5-hourly-scheduler',
};

/**
 * H1 AI Strategy Scheduler: creates/refreshes AI decisions and entry plans
 * from completed H1 candles for every enabled watchlist symbol. It never
 * calls order_check/order_send and never transitions an entry plan toward
 * execution — that is the EntryPlanWatcher's job (mt5-entry-plan-watcher.ts),
 * which runs on its own faster interval and does not need a new H1 candle to
 * detect that a WAITING plan's price condition was reached.
 */
export function startMt5HourlyScheduler(pool: Pool) {
  const intervalMs = Number(process.env.MT5_SCANNER_INTERVAL_MS ?? 60_000);
  const tick = () => runMt5HourlyTick(pool).catch((err) => {
    console.error('[api] MT5 hourly scheduler tick failed:', err);
  });
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}

export async function runMt5HourlyTick(pool: Pool) {
  const symbols = await pool.query(
    `SELECT i.symbol FROM watchlists w JOIN instruments i ON i.symbol = w.symbol
     WHERE w.enabled = true ORDER BY w.rank ASC, i.symbol ASC LIMIT 25`,
  );
  for (const row of symbols.rows) {
    await runAssistedAnalysis(pool, row.symbol, SYSTEM_ACTOR).catch((err) => {
      console.warn(`[api] MT5 AI scan skipped for ${row.symbol}:`, (err as Error).message);
    });
  }
}
