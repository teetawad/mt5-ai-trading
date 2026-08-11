import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { getPool } from '../db/client';
import { findAuditLogsByEntity, listAuditLogs } from '../db/repositories/audit-logs';

export const auditLogsRouter = Router();

auditLogsRouter.use(requireAuth);

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

function dateParam(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

auditLogsRouter.get('/', async (req: Request, res: Response) => {
  const page = pagination(req);
  if (!page) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const logs = await listAuditLogs(getPool(), {
    eventType: typeof req.query.eventType === 'string' ? req.query.eventType : undefined,
    entityId: typeof req.query.entityId === 'string' ? req.query.entityId : undefined,
    actorId: typeof req.query.actorId === 'string' ? req.query.actorId : undefined,
    from: dateParam(req.query.from),
    to: dateParam(req.query.to),
    ...page,
  });
  res.json({ auditLogs: logs, limit: page.limit, offset: page.offset });
});

auditLogsRouter.get('/:entityType/:entityId', async (req: Request, res: Response) => {
  const logs = await findAuditLogsByEntity(getPool(), req.params.entityType, req.params.entityId);
  res.json({ auditLogs: logs });
});
