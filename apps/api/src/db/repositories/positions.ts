import { Pool, PoolClient } from 'pg';
import { Position } from '../types';

function mapRow(row: Record<string, unknown>): Position {
  return {
    id: row.id as string,
    symbol: row.symbol as string,
    quantity: row.quantity as string,
    averageEntryPrice: row.average_entry_price as string | null,
    realizedPnl: row.realized_pnl as string,
    unrealizedPnl: row.unrealized_pnl as string,
    lastPrice: row.last_price as string | null,
    lastPriceAt: row.last_price_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function findPositionBySymbol(
  db: Pool | PoolClient,
  symbol: string,
): Promise<Position | null> {
  const { rows } = await db.query(
    'SELECT * FROM positions WHERE symbol = $1',
    [symbol],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findPositionBySymbolForUpdate(
  db: Pool | PoolClient,
  symbol: string,
): Promise<Position | null> {
  const { rows } = await db.query(
    'SELECT * FROM positions WHERE symbol = $1 FOR UPDATE',
    [symbol],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findAllPositions(db: Pool | PoolClient): Promise<Position[]> {
  const { rows } = await db.query('SELECT * FROM positions ORDER BY symbol');
  return rows.map(mapRow);
}

export async function findOpenPositions(db: Pool | PoolClient): Promise<Position[]> {
  const { rows } = await db.query(
    "SELECT * FROM positions WHERE quantity != '0' ORDER BY symbol",
  );
  return rows.map(mapRow);
}

export async function upsertPosition(
  db: Pool | PoolClient,
  data: {
    symbol: string;
    quantity: string;
    averageEntryPrice?: string | null;
    realizedPnl: string;
    unrealizedPnl: string;
    lastPrice?: string | null;
    lastPriceAt?: Date | null;
  },
): Promise<Position> {
  const { rows } = await db.query(
    `INSERT INTO positions
       (symbol, quantity, average_entry_price, realized_pnl, unrealized_pnl,
        last_price, last_price_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol) DO UPDATE
       SET quantity           = EXCLUDED.quantity,
           average_entry_price = EXCLUDED.average_entry_price,
           realized_pnl       = EXCLUDED.realized_pnl,
           unrealized_pnl     = EXCLUDED.unrealized_pnl,
           last_price         = EXCLUDED.last_price,
           last_price_at      = EXCLUDED.last_price_at,
           updated_at         = NOW()
     RETURNING *`,
    [
      data.symbol,
      data.quantity,
      data.averageEntryPrice ?? null,
      data.realizedPnl,
      data.unrealizedPnl,
      data.lastPrice ?? null,
      data.lastPriceAt ?? null,
    ],
  );
  return mapRow(rows[0]);
}
