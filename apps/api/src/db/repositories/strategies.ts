import { Pool, PoolClient } from 'pg';
import { Strategy } from '../types';

function mapRow(row: Record<string, unknown>): Strategy {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    version: row.version as string,
    parameters: row.parameters as Record<string, unknown>,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function findStrategyById(
  db: Pool | PoolClient,
  id: string,
): Promise<Strategy | null> {
  const { rows } = await db.query('SELECT * FROM strategies WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findAllStrategies(
  db: Pool | PoolClient,
  activeOnly = false,
): Promise<Strategy[]> {
  const { rows } = activeOnly
    ? await db.query('SELECT * FROM strategies WHERE is_active = TRUE ORDER BY name')
    : await db.query('SELECT * FROM strategies ORDER BY name');
  return rows.map(mapRow);
}

export async function createStrategy(
  db: Pool | PoolClient,
  data: {
    name: string;
    description?: string | null;
    version: string;
    parameters?: Record<string, unknown>;
  },
): Promise<Strategy> {
  const { rows } = await db.query(
    `INSERT INTO strategies (name, description, version, parameters)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.name, data.description ?? null, data.version, JSON.stringify(data.parameters ?? {})],
  );
  return mapRow(rows[0]);
}

export async function setStrategyActive(
  db: Pool | PoolClient,
  id: string,
  isActive: boolean,
): Promise<void> {
  await db.query(
    'UPDATE strategies SET is_active = $1, updated_at = NOW() WHERE id = $2',
    [isActive, id],
  );
}
