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
  const { logMt5RiskStartupSummary, syncMt5RiskSettingsToDatabase } = await import('./config/mt5-risk-settings');
  logMt5RiskStartupSummary();
  await syncMt5RiskSettingsToDatabase(getPoolForScheduler());
  const { startMt5HourlyScheduler } = await import('./services/mt5-hourly-scheduler');
  startMt5HourlyScheduler(getPoolForScheduler());
  const { startMt5EntryPlanWatcher } = await import('./services/mt5-entry-plan-watcher');
  startMt5EntryPlanWatcher(getPoolForScheduler());
  console.log('[api] EntryPlanWatcher started — WAITING/READY/TRIGGERED plans are monitored independently of the browser');
  const { startAiTradePlanWatcher } = await import('./services/trading-ai/ai-trade-plan-watcher');
  startAiTradePlanWatcher(getPoolForScheduler());
  const { isAiProviderConfigured } = await import('./services/trading-ai/provider');
  console.log(`[api] AiTradePlanWatcher started — real MT5 pending orders from the Trading AI are reconciled independently of the browser`);
  console.log(`[api] Trading AI provider: ${isAiProviderConfigured() ? `${process.env.TRADING_AI_PROVIDER}/${process.env.TRADING_AI_MODEL}` : 'AI PROVIDER NOT CONFIGURED'}`);

  const { loadFastLearningSettings } = await import('./config/fast-learning-settings');
  const { startM5CycleScheduler } = await import('./services/trading-ai/m5-cycle-scheduler');
  const { startShadowTradeWatcher } = await import('./services/trading-ai/shadow-trade-watcher');
  // Always started, but both self-gate on FAST_LEARNING_MODE every tick (same
  // pattern as the kill switch) — never a separate conditional boot path, so
  // the flag stays togglable without a server restart.
  startM5CycleScheduler(getPoolForScheduler());
  startShadowTradeWatcher(getPoolForScheduler());
  console.log(`[api] M5 Fast Learning Mode: ${loadFastLearningSettings().fast_learning_mode_enabled ? 'ON' : 'OFF'} (FAST_LEARNING_MODE) — shadow trades never call order_send`);
}

main().catch((error) => {
  console.error('[api] Failed to start:', error);
  process.exit(1);
});
