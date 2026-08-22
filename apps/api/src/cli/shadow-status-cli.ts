// Dev command (spec section 23): `npm run ai:shadow-status` — prints current
// Shadow Trade counts by status/exit_reason. Read-only.
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';

const envPath = path.resolve(__dirname, '../../../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const { createPool } = await import('../db/client');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    const byStatus = await pool.query('SELECT status, count(*)::int AS n FROM shadow_trades GROUP BY status ORDER BY status');
    const byExitReason = await pool.query(
      `SELECT exit_reason, count(*)::int AS n FROM shadow_trades WHERE status='CLOSED' GROUP BY exit_reason ORDER BY exit_reason`,
    );
    console.log('[ai:shadow-status] by status:');
    console.table(byStatus.rows);
    console.log('[ai:shadow-status] closed, by exit reason:');
    console.table(byExitReason.rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ai:shadow-status] Fatal:', err.message);
  process.exit(1);
});
