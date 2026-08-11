import { Pool, PoolClient } from 'pg';
import { Signal, SignalStatus } from '../types';

function mapRow(row: Record<string, unknown>): Signal {
  return {
    id: row.id as string,
    strategyId: row.strategy_id as string,
    symbol: row.symbol as string,
    side: row.side as 'BUY' | 'SELL',
    referencePrice: row.reference_price as string,
    reason: row.reason as string,
    strategyVersion: row.strategy_version as string,
    confidence: row.confidence as string | null,
    marketSnapshot: row.market_snapshot as Record<string, unknown>,
    status: row.status as SignalStatus,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

export async function findSignalById(
  db: Pool | PoolClient,
  id: string,
): Promise<Signal | null> {
  const { rows } = await db.query('SELECT * FROM signals WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createSignal(
  db: Pool | PoolClient,
  data: {
    strategyId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    referencePrice: string;
    reason: string;
    strategyVersion: string;
    confidence?: string | null;
    marketSnapshot: Record<string, unknown>;
    expiresAt: Date;
  },
): Promise<Signal> {
  const { rows } = await db.query(
    `INSERT INTO signals
       (strategy_id, symbol, side, reference_price, reason, strategy_version,
        confidence, market_snapshot, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.strategyId,
      data.symbol,
      data.side,
      data.referencePrice,
      data.reason,
      data.strategyVersion,
      data.confidence ?? null,
      JSON.stringify(data.marketSnapshot),
      data.expiresAt,
    ],
  );
  return mapRow(rows[0]);
}

export async function updateSignalStatus(
  db: Pool | PoolClient,
  id: string,
  status: SignalStatus,
): Promise<void> {
  await db.query('UPDATE signals SET status = $1 WHERE id = $2', [status, id]);
}

export async function findExpiredSignals(
  db: Pool | PoolClient,
): Promise<Signal[]> {
  const { rows } = await db.query(
    `SELECT * FROM signals
     WHERE status = 'CREATED' AND expires_at < NOW()
     ORDER BY expires_at`,
  );
  return rows.map(mapRow);
}
