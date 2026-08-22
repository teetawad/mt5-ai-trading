// Dev command (spec section 23): `npm run ai:m5-cycle` — runs one M5 cycle
// immediately, bypassing the scheduler's own candle-boundary check, and
// prints the resulting summary. Never places a real MT5 order (the cycle
// only creates AI trade plans + Shadow Trades, exactly as the automatic
// scheduler would for a real completed M5 candle).
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';

const envPath = path.resolve(__dirname, '../../../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const { createPool } = await import('../db/client');
  const { runOneM5Cycle, currentM5Boundary } = await import('../services/trading-ai/m5-cycle-scheduler');

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    const summary = await runOneM5Cycle(pool, currentM5Boundary());
    console.log('[ai:m5-cycle] cycle complete:');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ai:m5-cycle] Fatal:', err.message);
  process.exit(1);
});
