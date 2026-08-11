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
  ExecutionBlockedError,
  executeApprovedProposal,
  NotFoundError as ExecutionNotFoundError,
  ProposalExpiredError as ExecutionProposalExpiredError,
} from '../services/trade-execution-service';
import {
  approveProposal,
  cancelProposal,
  InvalidStateTransitionError,
  NotFoundError,
  ProposalExpiredError,
  rejectProposal,
  ValidationError,
} from '../services/trade-proposal-service';
import { TradingEngineError } from '../services/trading-engine-client';

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

function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

function approvalRequestId(req: Request): string | null {
  const body = req.body as { requestId?: unknown };
  return typeof body.requestId === 'string' ? body.requestId : requestId(req);
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

tradeProposalsRouter.post('/:id/approve', requireOwner, async (req: Request, res: Response) => {
  try {
    const actor = {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: approvalRequestId(req),
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    };
    const result = await approveProposal(getPool(), req.params.id, {
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      requestId: actor.requestId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    if (result.riskResult?.result === 'REJECT') {
      res.status(422).json({
        error: 'RISK_REVALIDATION_FAILED',
        proposal: result.proposal,
        approval: result.approval,
        riskCheck: result.riskCheck,
        failedRules: result.riskResult.failed_rules,
        reason: result.riskResult.reason,
      });
      return;
    }

    const execution = await executeApprovedProposal(getPool(), result.proposal.id, {
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      requestId: actor.requestId,
    });

    if (execution.execution.status === 'ERROR') {
      res.status(503).json({
        error: 'EXECUTION_ERROR',
        approval: result.approval,
        riskCheck: result.riskCheck,
        riskResult: result.riskResult,
        proposal: execution.proposal,
        execution: execution.execution,
        order: execution.order,
        fills: execution.fills,
      });
      return;
    }

    if (execution.execution.status === 'REJECTED') {
      res.status(422).json({
        error: 'EXECUTION_REJECTED',
        approval: result.approval,
        riskCheck: result.riskCheck,
        riskResult: result.riskResult,
        proposal: execution.proposal,
        execution: execution.execution,
        order: execution.order,
        fills: execution.fills,
      });
      return;
    }

    res.json({
      approval: result.approval,
      riskCheck: result.riskCheck,
      riskResult: result.riskResult,
      proposal: execution.proposal,
      execution: execution.execution,
      order: execution.order,
      fills: execution.fills,
      position: execution.position,
      idempotent: result.idempotent || execution.idempotent,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
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
    if (err instanceof ExecutionBlockedError) {
      res.status(422).json({
        error: 'EXECUTION_BLOCKED',
        message: err.message,
        failedRule: err.failedRule,
      });
      return;
    }
    if (err instanceof TradingEngineError) {
      res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: err.message });
      return;
    }
    throw err;
  }
});

tradeProposalsRouter.post('/:id/reject', requireOwner, async (req: Request, res: Response) => {
  const body = req.body as { reason?: unknown };
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    res.status(422).json({ error: 'VALIDATION_ERROR', message: 'reason must be a string' });
    return;
  }

  try {
    const result = await rejectProposal(
      getPool(),
      req.params.id,
      typeof body.reason === 'string' ? body.reason : null,
      {
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        requestId: approvalRequestId(req),
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      },
    );
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(422).json({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
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

tradeProposalsRouter.post('/:id/execute', requireOwner, async (req: Request, res: Response) => {
  try {
    const result = await executeApprovedProposal(getPool(), req.params.id, {
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      requestId: approvalRequestId(req),
    });

    if (result.execution.status === 'ERROR') {
      res.status(503).json({
        error: 'EXECUTION_ERROR',
        proposal: result.proposal,
        execution: result.execution,
        order: result.order,
        fills: result.fills,
      });
      return;
    }

    if (result.execution.status === 'REJECTED') {
      res.status(422).json({
        error: 'EXECUTION_REJECTED',
        proposal: result.proposal,
        execution: result.execution,
        order: result.order,
        fills: result.fills,
      });
      return;
    }

    res.json(result);
  } catch (err) {
    if (err instanceof ExecutionNotFoundError) {
      res.status(404).json({ error: 'NOT_FOUND', message: err.message });
      return;
    }
    if (err instanceof ExecutionProposalExpiredError) {
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
    if (err instanceof ExecutionBlockedError) {
      res.status(422).json({
        error: 'EXECUTION_BLOCKED',
        message: err.message,
        failedRule: err.failedRule,
      });
      return;
    }
    if (err instanceof TradingEngineError) {
      res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: err.message });
      return;
    }
    throw err;
  }
});
