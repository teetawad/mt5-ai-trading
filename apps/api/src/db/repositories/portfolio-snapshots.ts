import { Pool, PoolClient } from 'pg';
import { PortfolioSnapshot } from '../types';

function mapRow(row: Record<string, unknown>): PortfolioSnapshot {
  return {
    id: row.id as string,
    cashBalance: row.cash_balance as string,
    portfolioEquity: row.portfolio_equity as string,
    openPositions: row.open_positions as unknown[],
    pendingOrders: row.pending_orders as unknown[],
    realizedPnl: row.realized_pnl as string,
    unrealizedPnl: row.unrealized_pnl as string,
    dailyPnl: row.daily_pnl as string,
    snapshotReason: row.snapshot_reason as string,
    createdAt: row.created_at as Date,
  };
}

export async function findLatestSnapshot(
  db: Pool | PoolClient,
): Promise<PortfolioSnapshot | null> {
  const { rows } = await db.query(
    'SELECT * FROM portfolio_snapshots ORDER BY created_at DESC LIMIT 1',
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findLatestSnapshotBefore(
  db: Pool | PoolClient,
  cutoff: Date,
): Promise<PortfolioSnapshot | null> {
  const { rows } = await db.query(
    'SELECT * FROM portfolio_snapshots WHERE created_at < $1 ORDER BY created_at DESC LIMIT 1',
    [cutoff],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function hasSnapshotOnOrAfter(
  db: Pool | PoolClient,
  cutoff: Date,
): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM portfolio_snapshots WHERE created_at >= $1 LIMIT 1',
    [cutoff],
  );
  return rows.length > 0;
}

export async function findSnapshotById(
  db: Pool | PoolClient,
  id: string,
): Promise<PortfolioSnapshot | null> {
  const { rows } = await db.query(
    'SELECT * FROM portfolio_snapshots WHERE id = $1',
    [id],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listSnapshots(
  db: Pool | PoolClient,
  limit = 20,
  offset = 0,
): Promise<PortfolioSnapshot[]> {
  const { rows } = await db.query(
    `SELECT * FROM portfolio_snapshots
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows.map(mapRow);
}

export async function createSnapshot(
  db: Pool | PoolClient,
  data: {
    cashBalance: string;
    portfolioEquity: string;
    openPositions: unknown[];
    pendingOrders: unknown[];
    realizedPnl: string;
    unrealizedPnl: string;
    dailyPnl: string;
    snapshotReason: string;
  },
): Promise<PortfolioSnapshot> {
  const { rows } = await db.query(
    `INSERT INTO portfolio_snapshots
       (cash_balance, portfolio_equity, open_positions, pending_orders,
        realized_pnl, unrealized_pnl, daily_pnl, snapshot_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.cashBalance,
      data.portfolioEquity,
      JSON.stringify(data.openPositions),
      JSON.stringify(data.pendingOrders),
      data.realizedPnl,
      data.unrealizedPnl,
      data.dailyPnl,
      data.snapshotReason,
    ],
  );
  return mapRow(rows[0]);
}
