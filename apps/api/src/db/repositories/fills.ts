import { Pool, PoolClient } from 'pg';
import { Fill } from '../types';

function mapRow(row: Record<string, unknown>): Fill {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    quantity: row.quantity as string,
    price: row.price as string,
    fee: row.fee as string,
    fillType: row.fill_type as 'FULL' | 'PARTIAL',
    brokerFillId: row.broker_fill_id as string | null,
    filledAt: row.filled_at as Date,
  };
}

export async function findFillsByOrder(
  db: Pool | PoolClient,
  orderId: string,
): Promise<Fill[]> {
  const { rows } = await db.query(
    'SELECT * FROM fills WHERE order_id = $1 ORDER BY filled_at',
    [orderId],
  );
  return rows.map(mapRow);
}

export async function listRecentFills(
  db: Pool | PoolClient,
  limit = 20,
): Promise<Fill[]> {
  const { rows } = await db.query(
    'SELECT * FROM fills ORDER BY filled_at DESC LIMIT $1',
    [limit],
  );
  return rows.map(mapRow);
}

export async function findLatestFillBySymbol(
  db: Pool | PoolClient,
  symbol: string,
): Promise<Fill | null> {
  const { rows } = await db.query(
    `SELECT fills.*
     FROM fills
     JOIN orders ON orders.id = fills.order_id
     WHERE orders.symbol = $1
     ORDER BY fills.filled_at DESC
     LIMIT 1`,
    [symbol],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findFillByBrokerFillId(
  db: Pool | PoolClient,
  brokerFillId: string,
): Promise<Fill | null> {
  const { rows } = await db.query(
    'SELECT * FROM fills WHERE broker_fill_id = $1',
    [brokerFillId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createFill(
  db: Pool | PoolClient,
  data: {
    orderId: string;
    quantity: string;
    price: string;
    fee: string;
    fillType: 'FULL' | 'PARTIAL';
    brokerFillId?: string | null;
    filledAt?: Date;
  },
): Promise<Fill> {
  const { rows } = await db.query(
    `INSERT INTO fills
       (order_id, quantity, price, fee, fill_type, broker_fill_id, filled_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
     RETURNING *`,
    [
      data.orderId,
      data.quantity,
      data.price,
      data.fee,
      data.fillType,
      data.brokerFillId ?? null,
      data.filledAt ?? null,
    ],
  );
  return mapRow(rows[0]);
}
