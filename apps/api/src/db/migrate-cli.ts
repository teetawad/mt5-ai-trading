import { createPool } from './client';
import { runMigrations } from './migrate';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';

const explicitTestDatabaseUrl = Boolean(process.env.TEST_DATABASE_URL);
const envPath = path.resolve(__dirname, '../../../../.env');
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

async function main() {
  const url = explicitTestDatabaseUrl ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL or TEST_DATABASE_URL must be set');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    await runMigrations(pool);
    console.log('[migrate] All migrations applied successfully');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
