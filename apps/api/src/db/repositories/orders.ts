import { Pool, PoolClient } from 'pg';
import { AssetClass, Order, OrderStatus } from '../types';

function mapRow(row: Record<string, unknown>): Order {
  return {
    id: row.id as string,
    executionId: row.execution_id as string,
    brokerOrderId: row.broker_order_id as string | null,
    symbol: row.symbol as string,
    assetClass: row.asset_class as AssetClass,
    side: row.side as 'BUY' | 'SELL',
    quantity: row.quantity as string,
    orderType: row.order_type as string,
    limitPrice: row.limit_price as string | null,
    status: row.status as OrderStatus,
    filledQuantity: row.filled_quantity as string,
    averageFillPrice: row.average_fill_price as string | null,
    bracketOrderIds: row.bracket_order_ids as Record<string, string | null>,
    exitReason: row.exit_reason as Order['exitReason'],
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

export async function listOrders(
  db: Pool | PoolClient,
  filters: {
    status?: OrderStatus;
    symbol?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Order[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.symbol) {
    values.push(filters.symbol);
    clauses.push(`symbol = $${values.length}`);
  }

  values.push(filters.limit ?? 20);
  const limitParam = values.length;
  values.push(filters.offset ?? 0);
  const offsetParam = values.length;

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT * FROM orders
     ${where}
     ORDER BY created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values,
  );
  return rows.map(mapRow);
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

export interface OpenBracketOrder {
  orderId: string;
  proposalId: string;
  symbol: string;
  bracketOrderIds: Record<string, string | null>;
}

export async function findOpenBracketOrders(
  db: Pool | PoolClient,
): Promise<OpenBracketOrder[]> {
  const { rows } = await db.query(
    `SELECT o.id AS order_id, e.proposal_id AS proposal_id, o.symbol, o.bracket_order_ids
     FROM orders o
     JOIN executions e ON e.id = o.execution_id
     WHERE o.side = 'BUY'
       AND o.status = 'FILLED'
       AND NULLIF(o.bracket_order_ids ->> 'take_profit', '') IS NOT NULL
       AND NULLIF(o.bracket_order_ids ->> 'stop_loss', '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM orders x
         WHERE x.execution_id = o.execution_id AND x.exit_reason IS NOT NULL
       )`,
  );
  return rows.map((row) => ({
    orderId: row.order_id as string,
    proposalId: row.proposal_id as string,
    symbol: row.symbol as string,
    bracketOrderIds: row.bracket_order_ids as Record<string, string | null>,
  }));
}

export interface OpenIntradayPosition {
  orderId: string;
  proposalId: string;
  symbol: string;
  quantity: string;
  bracketOrderIds: Record<string, string | null>;
  enteredAt: Date;
  riskSnapshot: Record<string, unknown>;
}

/** Open Phase 25 (intraday) BUY positions with no exit recorded yet — used
 * by reconcileIntradayTimeExits to find candidates for a maximum-holding-time
 * or end-of-day force-close exit. Distinct from findOpenBracketOrders (which
 * covers all bracket-entry strategies, phase22 included) because time/EOD
 * exits are an intraday-mode-specific automatic risk control. */
export async function findOpenIntradayPositions(
  db: Pool | PoolClient,
): Promise<OpenIntradayPosition[]> {
  const { rows } = await db.query(
    `SELECT o.id AS order_id, e.proposal_id AS proposal_id, o.symbol, o.quantity,
            o.bracket_order_ids, o.created_at AS entered_at, p.risk_snapshot
     FROM orders o
     JOIN executions e ON e.id = o.execution_id
     JOIN trade_proposals p ON p.id = e.proposal_id
     WHERE o.side = 'BUY'
       AND o.status = 'FILLED'
       AND p.risk_snapshot ? 'phase25'
       AND NOT EXISTS (
         SELECT 1 FROM orders x
         WHERE x.execution_id = o.execution_id AND x.exit_reason IS NOT NULL
       )`,
  );
  return rows.map((row) => ({
    orderId: row.order_id as string,
    proposalId: row.proposal_id as string,
    symbol: row.symbol as string,
    quantity: row.quantity as string,
    bracketOrderIds: row.bracket_order_ids as Record<string, string | null>,
    enteredAt: row.entered_at as Date,
    riskSnapshot: row.risk_snapshot as Record<string, unknown>,
  }));
}

export async function findActiveOrdersBySymbol(
  db: Pool | PoolClient,
  symbol: string,
): Promise<Order[]> {
  const { rows } = await db.query(
    `SELECT * FROM orders
     WHERE symbol = $1
       AND status IN ('PENDING', 'SUBMITTED', 'PARTIALLY_FILLED')
     ORDER BY created_at`,
    [symbol],
  );
  return rows.map(mapRow);
}

export async function createOrder(
  db: Pool | PoolClient,
  data: {
    executionId: string;
    symbol: string;
    assetClass?: AssetClass;
    side: 'BUY' | 'SELL';
    quantity: string;
    orderType: string;
    limitPrice?: string | null;
    brokerOrderId?: string | null;
    bracketOrderIds?: Record<string, string | null>;
  },
): Promise<Order> {
  const { rows } = await db.query(
    `INSERT INTO orders
       (execution_id, symbol, asset_class, side, quantity, order_type, limit_price, broker_order_id, bracket_order_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.executionId,
      data.symbol,
      data.assetClass ?? 'STOCK',
      data.side,
      data.quantity,
      data.orderType,
      data.limitPrice ?? null,
      data.brokerOrderId ?? null,
      JSON.stringify(data.bracketOrderIds ?? {}),
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
    bracketOrderIds?: Record<string, string | null>;
    exitReason?: Order['exitReason'];
  } = {},
): Promise<Order> {
  const { rows } = await db.query(
    `UPDATE orders
     SET status            = $2,
         updated_at        = NOW(),
         filled_quantity   = COALESCE($3, filled_quantity),
         average_fill_price = COALESCE($4, average_fill_price),
         broker_order_id   = COALESCE($5, broker_order_id),
         bracket_order_ids = COALESCE($6, bracket_order_ids),
         exit_reason       = COALESCE($7, exit_reason)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      data.filledQuantity ?? null,
      data.averageFillPrice ?? null,
      data.brokerOrderId ?? null,
      data.bracketOrderIds ? JSON.stringify(data.bracketOrderIds) : null,
      data.exitReason ?? null,
    ],
  );
  return mapRow(rows[0]);
}
