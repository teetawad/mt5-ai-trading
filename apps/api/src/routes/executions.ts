import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findExecutionById, listExecutions } from '../db/repositories/executions';
import { findFillsByOrder } from '../db/repositories/fills';
import { findOrdersByExecution } from '../db/repositories/orders';

export const executionsRouter = Router();

executionsRouter.use(requireAuth);

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

executionsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = pagination(req);
  if (!parsed) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const executions = await listExecutions(getPool(), parsed.limit, parsed.offset);
  res.json({ executions, limit: parsed.limit, offset: parsed.offset });
});

executionsRouter.get('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  const execution = await findExecutionById(pool, req.params.id);
  if (!execution) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Execution not found' });
    return;
  }

  const orders = await findOrdersByExecution(pool, execution.id);
  const ordersWithFills = await Promise.all(
    orders.map(async (order) => ({
      ...order,
      fills: await findFillsByOrder(pool, order.id),
    })),
  );

  res.json({ ...execution, orders: ordersWithFills });
});
