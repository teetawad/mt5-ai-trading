import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { createRiskCheck, linkRiskCheckToProposal } from '../db/repositories/risk-checks';
import { createSignal, updateSignalStatus } from '../db/repositories/signals';
import { findStrategyById } from '../db/repositories/strategies';
import { getSettingValue } from '../db/repositories/system-settings';
import {
  createApproval,
  findApprovalByProposalAndRequestId,
} from '../db/repositories/trade-approvals';
import {
  createProposal,
  findActiveExposureProposals,
  findProposalByIdForUpdate,
  updateProposalStatus,
} from '../db/repositories/trade-proposals';
import { RiskCheck, Signal, TradeApproval, TradeProposal } from '../db/types';
import {
  getMarketSnapshot,
  getPaperPortfolio,
  RiskConfigDTO,
  RiskResultDTO,
  evaluateRisk,
} from './trading-engine-client';
import { assertValidProposalTransition, InvalidStateTransitionError } from './proposal-state-machine';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ProposalExpiredError extends Error {
  constructor(public readonly proposal: TradeProposal) {
    super('Proposal has expired');
    this.name = 'ProposalExpiredError';
  }
}

export class RiskRevalidationFailedError extends Error {
  constructor(
    public readonly proposal: TradeProposal,
    public readonly riskCheck: RiskCheck,
    public readonly riskResult: RiskResultDTO,
  ) {
    super(riskResult.reason ?? 'Risk revalidation failed');
    this.name = 'RiskRevalidationFailedError';
  }
}

export interface CreateSignalInput {
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  orderType?: 'MARKET' | 'LIMIT';
  limitPrice?: string | null;
  referencePrice?: string;
  reason: string;
  confidence?: string | null;
}

export interface ActorContext {
  actorId: string;
  actorEmail: string;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreateSignalWorkflowResult {
  signal: Signal;
  riskCheck: RiskCheck;
  riskResult: RiskResultDTO;
  proposal: TradeProposal;
}

export interface ApprovalWorkflowResult {
  proposal: TradeProposal;
  approval: TradeApproval;
  riskCheck?: RiskCheck;
  riskResult?: RiskResultDTO;
  idempotent: boolean;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

function validatePositiveDecimal(value: string, field: string): void {
  if (!DECIMAL_PATTERN.test(value) || new Decimal(value).lte(0)) {
    throw new ValidationError(`${field} must be a positive decimal string`);
  }
}

function parseTtlSeconds(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 300;
}

async function riskConfig(db: PoolClient): Promise<RiskConfigDTO> {
  const drift = new Decimal(String(await getSettingValue(db, 'price_drift_threshold_pct') ?? '0.02'));
  const concentration = new Decimal(
    String(await getSettingValue(db, 'max_portfolio_concentration_pct') ?? '0.20'),
  );

  return {
    kill_switch_enabled: await getSettingValue<boolean>(db, 'trading_kill_switch_enabled') ?? true,
    trading_mode: await getSettingValue<string>(db, 'trading_mode') ?? 'PAPER',
    market_data_staleness_seconds:
      Number(await getSettingValue(db, 'market_data_staleness_seconds') ?? 60),
    price_drift_threshold_pct: drift.mul(100).toString(),
    max_order_notional_usd: String(await getSettingValue(db, 'max_order_notional_usd') ?? '10000'),
    max_position_size_usd: String(await getSettingValue(db, 'max_position_size_usd') ?? '50000'),
    max_portfolio_concentration_pct: concentration.mul(100).toString(),
    max_open_positions: Number(await getSettingValue(db, 'max_open_positions') ?? 10),
    max_daily_loss_usd: String(await getSettingValue(db, 'max_daily_loss_usd') ?? '1000'),
    proposal_ttl_seconds: parseTtlSeconds(await getSettingValue(db, 'proposal_ttl_seconds')),
    trading_session_start:
      await getSettingValue<string | null>(db, 'trading_session_start') ?? undefined,
    trading_session_end:
      await getSettingValue<string | null>(db, 'trading_session_end') ?? undefined,
    cooldown_between_trades_seconds:
      Number(await getSettingValue(db, 'cooldown_between_trades_seconds') ?? 0),
  };
}

function proposalSnapshot(proposal: TradeProposal): Record<string, unknown> {
  return {
    id: proposal.id,
    signalId: proposal.signalId,
    symbol: proposal.symbol,
    side: proposal.side,
    quantity: proposal.quantity,
    orderType: proposal.orderType,
    referencePrice: proposal.referencePrice,
    limitPrice: proposal.limitPrice,
    estimatedNotional: proposal.estimatedNotional,
    status: proposal.status,
    expiresAt: proposal.expiresAt.toISOString(),
  };
}

function requireRequestId(requestId: string | null | undefined): string {
  if (!requestId || !requestId.trim()) {
    throw new ValidationError('requestId is required');
  }
  return requestId.trim();
}

async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createSignalAndProposal(
  pool: Pool,
  input: CreateSignalInput,
  actor: ActorContext,
): Promise<CreateSignalWorkflowResult> {
  const symbol = input.symbol.toUpperCase();
  const orderType = input.orderType ?? 'MARKET';

  if (!/^[A-Z0-9.]{1,10}$/.test(symbol)) throw new ValidationError('Invalid symbol format');
  validatePositiveDecimal(input.quantity, 'quantity');
  if (input.referencePrice !== undefined) validatePositiveDecimal(input.referencePrice, 'referencePrice');
  if (orderType === 'LIMIT') {
    if (!input.limitPrice) throw new ValidationError('limitPrice is required for LIMIT orders');
    validatePositiveDecimal(input.limitPrice, 'limitPrice');
  }
  if (orderType === 'MARKET' && input.limitPrice) {
    throw new ValidationError('limitPrice is only valid for LIMIT orders');
  }
  if (!input.reason.trim()) throw new ValidationError('reason is required');

  const market = await getMarketSnapshot(symbol, actor.requestId ?? undefined);
  if (!market) throw new NotFoundError(`Symbol not found: ${symbol}`);
  const paperPortfolio = await getPaperPortfolio(actor.requestId ?? undefined);

  return withTransaction(pool, async (client) => {
    const strategy = await findStrategyById(client, input.strategyId);
    if (!strategy || !strategy.isActive) throw new NotFoundError('Strategy not found');

    const cfg = await riskConfig(client);
    const ttlSeconds = cfg.proposal_ttl_seconds ?? 300;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const latestSnapshot = await findLatestSnapshot(client);
    const referencePrice = input.referencePrice ?? market.price;
    const estimatedNotional = new Decimal(input.quantity).mul(market.price).toFixed(8);

    const signal = await createSignal(client, {
      strategyId: strategy.id,
      symbol,
      side: input.side,
      referencePrice,
      reason: input.reason.trim(),
      strategyVersion: strategy.version,
      confidence: input.confidence ?? null,
      marketSnapshot: { ...market },
      expiresAt,
    });

    const portfolio = {
      cash: paperPortfolio.cash,
      positions: paperPortfolio.positions,
      equity: latestSnapshot?.portfolioEquity ?? paperPortfolio.cash,
      daily_pnl: latestSnapshot?.dailyPnl ?? '0',
    };

    const riskResult = await evaluateRisk(
      {
        stage: 'PRE_PROPOSAL',
        proposal: {
          symbol,
          side: input.side,
          quantity: input.quantity,
          reference_price: referencePrice,
          expires_at: expiresAt.toISOString(),
        },
        market,
        portfolio,
        config: cfg,
        pending_proposals: await findActiveExposureProposals(client),
      },
      actor.requestId ?? undefined,
    );

    const riskCheck = await createRiskCheck(client, {
      signalId: signal.id,
      stage: 'PRE_PROPOSAL',
      result: riskResult.result,
      rulesChecked: riskResult.rules_checked,
      failedRules: riskResult.failed_rules,
      reason: riskResult.reason,
      marketSnapshot: { ...riskResult.market_snapshot },
      portfolioSnapshot: { ...riskResult.portfolio_snapshot },
    });

    const proposal = await createProposal(client, {
      signalId: signal.id,
      strategyId: strategy.id,
      symbol,
      side: input.side,
      quantity: input.quantity,
      orderType,
      referencePrice,
      limitPrice: orderType === 'LIMIT' ? input.limitPrice : null,
      estimatedNotional,
      riskCheckId: riskCheck.id,
      riskSnapshot: riskResult as unknown as Record<string, unknown>,
      portfolioSnapshot: { ...riskResult.portfolio_snapshot },
      expiresAt,
    });

    await linkRiskCheckToProposal(client, riskCheck.id, proposal.id);

    const nextStatus = riskResult.result === 'PASS' ? 'PENDING_APPROVAL' : 'RISK_REJECTED';
    assertValidProposalTransition(proposal.status, nextStatus);
    const finalProposal = await updateProposalStatus(
      client,
      proposal.id,
      nextStatus,
      nextStatus === 'PENDING_APPROVAL' ? { pendingApprovalAt: new Date() } : {},
    );
    const signalStatus = riskResult.result === 'PASS' ? 'RISK_PASS' : 'RISK_FAIL';
    await updateSignalStatus(client, signal.id, signalStatus);

    await createAuditLog(client, {
      eventType: 'TRADE_PROPOSAL_CREATED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: finalProposal.id,
      action: 'CREATE_TRADE_PROPOSAL',
      afterData: proposalSnapshot(finalProposal),
      requestId: actor.requestId ?? null,
    });

    return {
      signal: { ...signal, status: signalStatus },
      riskCheck: { ...riskCheck, proposalId: finalProposal.id },
      riskResult,
      proposal: finalProposal,
    };
  });
}

export async function cancelProposal(
  pool: Pool,
  proposalId: string,
  actor: ActorContext,
): Promise<TradeProposal> {
  return withTransaction(pool, async (client) => {
    const proposal = await findProposalByIdForUpdate(client, proposalId);
    if (!proposal) throw new NotFoundError('Trade proposal not found');

    const now = new Date();
    if (proposal.expiresAt <= now && proposal.status === 'PENDING_APPROVAL') {
      assertValidProposalTransition(proposal.status, 'EXPIRED');
      const expired = await updateProposalStatus(client, proposal.id, 'EXPIRED');
      throw new ProposalExpiredError(expired);
    }

    assertValidProposalTransition(proposal.status, 'CANCELLED');
    const cancelled = await updateProposalStatus(client, proposal.id, 'CANCELLED');

    await createAuditLog(client, {
      eventType: 'TRADE_PROPOSAL_CANCELLED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: cancelled.id,
      action: 'CANCEL_TRADE_PROPOSAL',
      beforeData: proposalSnapshot(proposal),
      afterData: proposalSnapshot(cancelled),
      requestId: actor.requestId ?? null,
    });

    return cancelled;
  });
}

export async function approveProposal(
  pool: Pool,
  proposalId: string,
  actor: ActorContext,
): Promise<ApprovalWorkflowResult> {
  const requestId = requireRequestId(actor.requestId);

  return withTransaction(pool, async (client) => {
    const proposal = await findProposalByIdForUpdate(client, proposalId);
    if (!proposal) throw new NotFoundError('Trade proposal not found');

    const existingApproval = await findApprovalByProposalAndRequestId(client, proposal.id, requestId);
    if (existingApproval) {
      return { proposal, approval: existingApproval, idempotent: true };
    }

    if (proposal.status !== 'PENDING_APPROVAL') {
      throw new InvalidStateTransitionError(proposal.status, 'APPROVED');
    }

    const now = new Date();
    if (proposal.expiresAt <= now) {
      assertValidProposalTransition(proposal.status, 'EXPIRED');
      const expired = await updateProposalStatus(client, proposal.id, 'EXPIRED');
      throw new ProposalExpiredError(expired);
    }

    const market = await getMarketSnapshot(proposal.symbol, actor.requestId ?? undefined);
    if (!market) throw new NotFoundError(`Symbol not found: ${proposal.symbol}`);
    const paperPortfolio = await getPaperPortfolio(actor.requestId ?? undefined);
    const latestSnapshot = await findLatestSnapshot(client);
    const cfg = await riskConfig(client);

    const riskResult = await evaluateRisk(
      {
        stage: 'PRE_EXECUTION',
        proposal: {
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: proposal.quantity,
          reference_price: proposal.referencePrice,
          expires_at: proposal.expiresAt.toISOString(),
        },
        market,
        portfolio: {
          cash: paperPortfolio.cash,
          positions: paperPortfolio.positions,
          equity: latestSnapshot?.portfolioEquity ?? paperPortfolio.cash,
          daily_pnl: latestSnapshot?.dailyPnl ?? '0',
        },
        config: cfg,
        pending_proposals: await findActiveExposureProposals(client, proposal.id),
      },
      actor.requestId ?? undefined,
    );

    const riskCheck = await createRiskCheck(client, {
      signalId: proposal.signalId,
      proposalId: proposal.id,
      stage: 'PRE_EXECUTION',
      result: riskResult.result,
      rulesChecked: riskResult.rules_checked,
      failedRules: riskResult.failed_rules,
      reason: riskResult.reason,
      marketSnapshot: { ...riskResult.market_snapshot },
      portfolioSnapshot: { ...riskResult.portfolio_snapshot },
    });

    const approval = await createApproval(client, {
      proposalId: proposal.id,
      approvedBy: actor.actorId,
      action: 'APPROVE',
      requestId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });

    if (riskResult.result === 'REJECT') {
      assertValidProposalTransition(proposal.status, 'APPROVED');
      const approved = await updateProposalStatus(client, proposal.id, 'APPROVED', {
        approvedAt: now,
      });
      assertValidProposalTransition(approved.status, 'REVALIDATING');
      const revalidating = await updateProposalStatus(client, approved.id, 'REVALIDATING');
      assertValidProposalTransition(revalidating.status, 'RISK_REJECTED_AFTER_APPROVAL');
      const rejectedAfterApproval = await updateProposalStatus(
        client,
        revalidating.id,
        'RISK_REJECTED_AFTER_APPROVAL',
      );

      await createAuditLog(client, {
        eventType: 'TRADE_PROPOSAL_APPROVAL_RISK_REJECTED',
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        entityType: 'trade_proposal',
        entityId: rejectedAfterApproval.id,
        action: 'APPROVE_REJECTED_BY_RISK',
        beforeData: proposalSnapshot(proposal),
        afterData: proposalSnapshot(rejectedAfterApproval),
        requestId,
      });

      return {
        proposal: rejectedAfterApproval,
        approval,
        riskCheck,
        riskResult,
        idempotent: false,
      };
    }

    assertValidProposalTransition(proposal.status, 'APPROVED');
    const approved = await updateProposalStatus(client, proposal.id, 'APPROVED', {
      approvedAt: now,
    });

    await createAuditLog(client, {
      eventType: 'TRADE_PROPOSAL_APPROVED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: approved.id,
      action: 'APPROVE_TRADE_PROPOSAL',
      beforeData: proposalSnapshot(proposal),
      afterData: proposalSnapshot(approved),
      requestId,
    });

    return { proposal: approved, approval, riskCheck, riskResult, idempotent: false };
  });
}

export async function rejectProposal(
  pool: Pool,
  proposalId: string,
  reason: string | null,
  actor: ActorContext,
): Promise<ApprovalWorkflowResult> {
  const requestId = requireRequestId(actor.requestId);

  return withTransaction(pool, async (client) => {
    const proposal = await findProposalByIdForUpdate(client, proposalId);
    if (!proposal) throw new NotFoundError('Trade proposal not found');

    const existingApproval = await findApprovalByProposalAndRequestId(client, proposal.id, requestId);
    if (existingApproval) {
      return { proposal, approval: existingApproval, idempotent: true };
    }

    if (proposal.status !== 'PENDING_APPROVAL') {
      throw new InvalidStateTransitionError(proposal.status, 'OWNER_REJECTED');
    }

    if (proposal.expiresAt <= new Date()) {
      assertValidProposalTransition(proposal.status, 'EXPIRED');
      const expired = await updateProposalStatus(client, proposal.id, 'EXPIRED');
      throw new ProposalExpiredError(expired);
    }

    const approval = await createApproval(client, {
      proposalId: proposal.id,
      approvedBy: actor.actorId,
      action: 'REJECT',
      reason,
      requestId,
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });

    assertValidProposalTransition(proposal.status, 'OWNER_REJECTED');
    const rejected = await updateProposalStatus(client, proposal.id, 'OWNER_REJECTED', {
      rejectedAt: new Date(),
    });

    await createAuditLog(client, {
      eventType: 'TRADE_PROPOSAL_REJECTED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: rejected.id,
      action: 'REJECT_TRADE_PROPOSAL',
      beforeData: proposalSnapshot(proposal),
      afterData: { ...proposalSnapshot(rejected), reason },
      requestId,
    });

    return { proposal: rejected, approval, idempotent: false };
  });
}

export { InvalidStateTransitionError };
