import { createPool } from './client';

async function main() {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL or TEST_DATABASE_URL must be set');
    process.exit(1);
  }

  if (!url.includes('test') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
    console.error('db:reset only allowed on test/local databases');
    process.exit(1);
  }

  const pool = createPool(url);
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    console.log('[reset] Database reset complete');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[reset] Fatal:', err.message);
  process.exit(1);
});
