import { Pool, PoolClient } from 'pg';
import { Order, OrderStatus } from '../types';

function mapRow(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    executionId: row.execution_id as string,
    brokerOrderId: row.broker_order_id as string | null,
    symbol: row.symbol as string,
    side: row.side as 'BUY' | 'SELL',
    quantity: row.quantity as string,
    orderType: row.order_type as string,
    limitPrice: row.limit_price as string | null,
    status: row.status as OrderStatus,
    filledQuantity: row.filled_quantity as string,
    averageFillPrice: row.average_fill_price as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function findOrderById(
  db: Pool | PoolClient,
  id: string,
): Promise<Order | null> {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function findOrdersByExecution(
  db: Pool | PoolClient,
  executionId: string,
): Promise<Order[]> {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE execution_id = $1 ORDER BY created_at',
    [executionId],
  );
  return rows.map(mapRow);
}

export async function findOrderByExecution(
  db: Pool | PoolClient,
  executionId: string,
): Promise<Order | null> {
  const { rows } = await db.query(
    'SELECT * FROM orders WHERE execution_id = $1 ORDER BY created_at LIMIT 1',
    [executionId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createOrder(
  db: Pool | PoolClient,
  data: {
    executionId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: string;
    orderType: string;
    limitPrice?: string | null;
    brokerOrderId?: string | null;
  },
): Promise<Order> {
  const { rows } = await db.query(
    `INSERT INTO orders
       (execution_id, symbol, side, quantity, order_type, limit_price, broker_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.executionId,
      data.symbol,
      data.side,
      data.quantity,
      data.orderType,
      data.limitPrice ?? null,
      data.brokerOrderId ?? null,
    ],
  );
  return mapRow(rows[0]);
}

export async function updateOrderStatus(
  db: Pool | PoolClient,
  id: string,
  status: OrderStatus,
  data: {
    filledQuantity?: string;
    averageFillPrice?: string | null;
    brokerOrderId?: string | null;
  } = {},
): Promise<Order> {
  const { rows } = await db.query(
    `UPDATE orders
     SET status            = $2,
         updated_at        = NOW(),
         filled_quantity   = COALESCE($3, filled_quantity),
         average_fill_price = COALESCE($4, average_fill_price),
         broker_order_id   = COALESCE($5, broker_order_id)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      data.filledQuantity ?? null,
      data.averageFillPrice ?? null,
      data.brokerOrderId ?? null,
    ],
  );
  return mapRow(rows[0]);
}
