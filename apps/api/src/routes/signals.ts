import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import { findSignalById, listSignals } from '../db/repositories/signals';
import { SignalStatus } from '../db/types';
import {
  createManualTestSignalAndProposal,
  createAiDecisionAndProposal,
  createSignalAndProposal,
  manualTestSignalOptions,
  NotFoundError,
  ValidationError,
} from '../services/trade-proposal-service';

export const signalsRouter = Router();

signalsRouter.use(requireAuth);

const SIGNAL_STATUSES = new Set<SignalStatus>(['CREATED', 'RISK_PASS', 'RISK_FAIL', 'EXPIRED']);

function requestId(req: Request): string | null {
  return (req.headers['x-request-id'] as string | undefined) ?? null;
}

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

signalsRouter.get('/', async (req: Request, res: Response) => {
  const page = pagination(req);
  if (!page) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const status = req.query.status as SignalStatus | undefined;
  if (status && !SIGNAL_STATUSES.has(status)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid signal status' });
    return;
  }

  const signals = await listSignals(getPool(), {
    status,
    strategyId: req.query.strategyId as string | undefined,
    symbol: typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined,
    ...page,
  });
  res.json({ signals, limit: page.limit, offset: page.offset });
});

signalsRouter.get('/manual-test/options', async (req: Request, res: Response) => {
  res.json(await manualTestSignalOptions(requestId(req)));
});

signalsRouter.post('/manual-test', requireOwner, async (req: Request, res: Response) => {
  try {
    const result = await createManualTestSignalAndProposal(getPool(), req.body, {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: requestId(req),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    throw err;
  }
});

signalsRouter.post('/ai-decision', requireOwner, async (req: Request, res: Response) => {
  try {
    const result = await createAiDecisionAndProposal(getPool(), req.body, {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: requestId(req),
    });
    res.status(result.proposal ? 201 : 200).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    throw err;
  }
});

signalsRouter.get('/:id', async (req: Request, res: Response) => {
  const signal = await findSignalById(getPool(), req.params.id);
  if (!signal) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Signal not found' });
    return;
  }
  res.json(signal);
});

signalsRouter.post('/', requireOwner, async (req: Request, res: Response) => {
  try {
    const result = await createSignalAndProposal(getPool(), req.body, {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: requestId(req),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    throw err;
  }
});
