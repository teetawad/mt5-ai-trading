// Dev command (spec section 23): `npm run ai:shadow-evaluate` — runs one
// shadow-watcher reconciliation pass immediately (trigger detection, TP/SL/
// expiry outcome evaluation) and prints what changed. Never calls order_send
// — only historical MT5 candle data (getMt5Bars).
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';

const envPath = path.resolve(__dirname, '../../../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const { createPool } = await import('../db/client');
  const { runShadowTradeWatcherTick } = await import('../services/trading-ai/shadow-trade-watcher');

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    const summary = await runShadowTradeWatcherTick(pool);
    console.log('[ai:shadow-evaluate] reconciliation pass complete:');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ai:shadow-evaluate] Fatal:', err.message);
  process.exit(1);
});
