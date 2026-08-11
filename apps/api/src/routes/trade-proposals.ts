import { Router, Request, Response } from 'express';
import { requireAuth, requireOwner } from '../auth/middleware';
import { getPool } from '../db/client';
import {
  expireOpenProposals,
  findProposalById,
  listProposals,
} from '../db/repositories/trade-proposals';
import { ProposalStatus } from '../db/types';
import {
  cancelProposal,
  InvalidStateTransitionError,
  NotFoundError,
  ProposalExpiredError,
} from '../services/trade-proposal-service';

export const tradeProposalsRouter = Router();

tradeProposalsRouter.use(requireAuth);

const PROPOSAL_STATUSES = new Set<ProposalStatus>([
  'RISK_CHECKING',
  'RISK_REJECTED',
  'PENDING_APPROVAL',
  'OWNER_REJECTED',
  'EXPIRED',
  'APPROVED',
  'REVALIDATING',
  'RISK_REJECTED_AFTER_APPROVAL',
  'SUBMITTING',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCEL_PENDING',
  'CANCELLED',
  'EXECUTION_REJECTED',
  'EXECUTION_ERROR',
]);

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

tradeProposalsRouter.get('/', async (req: Request, res: Response) => {
  const page = pagination(req);
  if (!page) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid pagination' });
    return;
  }

  const status = req.query.status as ProposalStatus | undefined;
  if (status && !PROPOSAL_STATUSES.has(status)) {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'Invalid proposal status' });
    return;
  }

  const pool = getPool();
  await expireOpenProposals(pool);
  const proposals = await listProposals(pool, {
    status,
    symbol: typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : undefined,
    ...page,
  });
  res.json({ proposals, limit: page.limit, offset: page.offset });
});

tradeProposalsRouter.get('/:id', async (req: Request, res: Response) => {
  const pool = getPool();
  await expireOpenProposals(pool);
  const proposal = await findProposalById(pool, req.params.id);
  if (!proposal) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Trade proposal not found' });
    return;
  }
  res.json(proposal);
});

tradeProposalsRouter.patch('/:id/cancel', requireOwner, async (req: Request, res: Response) => {
  try {
    const proposal = await cancelProposal(getPool(), req.params.id, {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: requestId(req),
    });
    res.json(proposal);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    if (err instanceof ProposalExpiredError) {
      res.status(410).json({
        error: 'PROPOSAL_EXPIRED',
        message: err.message,
        expiredAt: err.proposal.expiresAt.toISOString(),
      });
      return;
    }
    if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({
        error: 'INVALID_STATE',
        message: err.message,
        currentStatus: err.from,
      });
      return;
    }
    throw err;
  }
});
