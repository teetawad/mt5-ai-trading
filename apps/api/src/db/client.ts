import { Pool, PoolConfig } from 'pg';

function createPool(connectionString?: string): Pool {
  const config: PoolConfig = {
    connectionString: connectionString ?? process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  };

  if (!config.connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return new Pool(config);
}

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = createPool();
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export { createPool };
