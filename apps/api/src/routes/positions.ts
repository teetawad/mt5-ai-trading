import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findOpenPositions, findPositionBySymbol } from '../db/repositories/positions';

export const positionsRouter = Router();

positionsRouter.use(requireAuth);

positionsRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await findOpenPositions(getPool()));
});

positionsRouter.get('/:symbol', async (req: Request, res: Response) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!/^[A-Z0-9.]{1,10}$/.test(symbol)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid symbol format' });
    return;
  }

  const position = await findPositionBySymbol(getPool(), symbol);
  if (!position) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Position not found' });
    return;
  }
  res.json(position);
});
