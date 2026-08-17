import { Pool } from 'pg';
import { executeAutoDemo, processMt5EntryPlans, runAssistedAnalysis } from './mt5-demo-lab-service';
import { loadMt5RiskSettings } from '../config/mt5-risk-settings';

const SYSTEM_ACTOR = {
  actorId: null,
  actorEmail: 'mt5-hourly-scheduler@internal',
  requestId: 'mt5-hourly-scheduler',
};

export function startMt5HourlyScheduler(pool: Pool) {
  const intervalMs = Number(process.env.MT5_SCANNER_INTERVAL_MS ?? 60_000);
  const tick = () => runMt5HourlyTick(pool).catch((err) => {
    console.error('[api] MT5 hourly scheduler tick failed:', err);
  });
  setTimeout(tick, 5_000);
  setInterval(tick, intervalMs);
}

export async function runMt5HourlyTick(pool: Pool) {
  const enabled = loadMt5RiskSettings().mt5_auto_demo_enabled;
  await processMt5EntryPlans(pool, SYSTEM_ACTOR, enabled).catch((err) => {
    console.warn('[api] MT5 entry-plan monitor skipped:', (err as Error).message);
  });
  const symbols = await pool.query(
    `SELECT i.symbol FROM watchlists w JOIN instruments i ON i.symbol = w.symbol
     WHERE w.enabled = true ORDER BY w.rank ASC, i.symbol ASC LIMIT 25`,
  );
  for (const row of symbols.rows) {
    if (enabled) {
      await executeAutoDemo(pool, row.symbol, SYSTEM_ACTOR).catch(async (err) => {
        await runAssistedAnalysis(pool, row.symbol, SYSTEM_ACTOR).catch(() => null);
        console.warn(`[api] MT5 AUTO-DEMO skipped for ${row.symbol}:`, (err as Error).message);
      });
    } else {
      await runAssistedAnalysis(pool, row.symbol, SYSTEM_ACTOR).catch((err) => {
        console.warn(`[api] MT5 assisted scan skipped for ${row.symbol}:`, (err as Error).message);
      });
    }
  }
}
