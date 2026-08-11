import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findOrderById, listOrders } from '../db/repositories/orders';
import { OrderStatus } from '../db/types';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

const ORDER_STATUSES = new Set<OrderStatus>([
  'PENDING',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'ERROR',
]);

function pagination(req: Request): { limit: number; offset: number } | null {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (
    !Number.isInteger(limit)
    || !Number.isInteger(offset)
    || limit < 1
    || limit > 100
    || offset < 0
  ) {
    return null;
  }
  return { limit, offset };
}

ordersRouter.get('/', async (req: Request, res: Response) => {
  const page = pagination(req);
  if (!page) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const status = req.query.status as OrderStatus | undefined;
  if (status && !ORDER_STATUSES.has(status)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid order status' });
    return;
  }

  const orders = await listOrders(getPool(), {
    status,
    symbol: typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined,
    ...page,
  });
  res.json({ orders, limit: page.limit, offset: page.offset });
});

ordersRouter.get('/:id', async (req: Request, res: Response) => {
  const order = await findOrderById(getPool(), req.params.id);
  if (!order) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Order not found' });
    return;
  }
  res.json(order);
});
