import { Router, Request, Response } from 'express';
import { getPool } from '../db/client';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'api',
    mode: 'PAPER',
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/db', async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ now: Date }>('SELECT NOW() AS now');
    res.json({
      status: 'ok',
      service: 'api',
      database: 'connected',
      serverTime: rows[0].now,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'api',
      database: 'unreachable',
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});
