import { Router, Request, Response } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'api',
    mode: 'PAPER',
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/db', (_req: Request, res: Response) => {
  // Phase 2 adds the real DB connectivity check
  res.json({
    status: 'pending',
    service: 'api',
    database: 'not_configured_until_phase_2',
    timestamp: new Date().toISOString(),
  });
});
