import { Pool, PoolClient } from 'pg';

export interface HourlyWatchlistEntry {
  id: string;
  symbol: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

function mapRow(row: Record<string, unknown>): HourlyWatchlistEntry {
  return {
    id: row.id as string,
    symbol: row.symbol as string,
    enabled: row.enabled as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    updatedBy: row.updated_by as string | null,
  };
}

export async function listWatchlist(db: Pool | PoolClient): Promise<HourlyWatchlistEntry[]> {
  const { rows } = await db.query('SELECT * FROM hourly_watchlist ORDER BY symbol');
  return rows.map(mapRow);
}

export async function findEnabledWatchlistSymbols(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ symbol: string }>(
    'SELECT symbol FROM hourly_watchlist WHERE enabled = true ORDER BY symbol',
  );
  return rows.map((row) => row.symbol);
}

export async function addWatchlistSymbol(
  db: Pool | PoolClient,
  symbol: string,
  updatedBy?: string | null,
): Promise<HourlyWatchlistEntry> {
  const { rows } = await db.query(
    `INSERT INTO hourly_watchlist (symbol, enabled, updated_by)
     VALUES ($1, true, $2)
     ON CONFLICT (symbol) DO UPDATE
       SET enabled = true, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [symbol, updatedBy ?? null],
  );
  return mapRow(rows[0]);
}

export async function setWatchlistSymbolEnabled(
  db: Pool | PoolClient,
  id: string,
  enabled: boolean,
  updatedBy?: string | null,
): Promise<HourlyWatchlistEntry | null> {
  const { rows } = await db.query(
    `UPDATE hourly_watchlist
     SET enabled = $2, updated_at = NOW(), updated_by = $3
     WHERE id = $1
     RETURNING *`,
    [id, enabled, updatedBy ?? null],
  );
  return rows.length ? mapRow(rows[0]) : null;
}
