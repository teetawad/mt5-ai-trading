import { Pool, PoolClient } from 'pg';
import { createPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function getTestPool(): Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is not set — skipping DB tests');
  }
  return createPool(TEST_DATABASE_URL);
}

export async function setupTestDb(pool: Pool): Promise<void> {
  await runMigrations(pool);
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
  }
}
