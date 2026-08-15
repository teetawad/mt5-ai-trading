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
    console.log(`[api] MT5 AI DEMO Trading Lab API running at http://${HOST}:${PORT}`);
    console.log('[api] Mode: MT5 DEMO ONLY — real/live execution is blocked server-side');
  });

  const { getPool: getPoolForScheduler } = await import('./db/client');
  const { startMt5HourlyScheduler } = await import('./services/mt5-hourly-scheduler');
  startMt5HourlyScheduler(getPoolForScheduler());
}

main().catch((error) => {
  console.error('[api] Failed to start:', error);
  process.exit(1);
});
