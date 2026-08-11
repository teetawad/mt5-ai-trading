import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import {
  createExecution,
  findExecutionByIdempotencyKey,
  updateExecutionStatus,
} from '../db/repositories/executions';
import { createFill, findFillByBrokerFillId, findFillsByOrder } from '../db/repositories/fills';
import { createOrder, findOrderByExecution, updateOrderStatus } from '../db/repositories/orders';
import { createSnapshot } from '../db/repositories/portfolio-snapshots';
import {
  findAllPositions,
  findPositionBySymbolForUpdate,
  findOpenPositions,
  upsertPosition,
} from '../db/repositories/positions';
import { getSettingValue } from '../db/repositories/system-settings';
import {
  findProposalByIdForUpdate,
  updateProposalStatus,
} from '../db/repositories/trade-proposals';
import { Execution, Fill, Order, Position, TradeProposal } from '../db/types';
import { assertValidProposalTransition, InvalidStateTransitionError } from './proposal-state-machine';
import {
  FillEventDTO,
  getPaperPortfolio,
  OrderResultDTO,
  submitOrder,
} from './trading-engine-client';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ProposalExpiredError extends Error {
  constructor(public readonly proposal: TradeProposal) {
    super('Trade proposal expired');
    this.name = 'ProposalExpiredError';
  }
}

export class ExecutionBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly failedRule: 'KILL_SWITCH' | 'TRADING_MODE',
  ) {
    super(reason);
    this.name = 'ExecutionBlockedError';
  }
}

export interface ActorContext {
  actorId: string;
  actorEmail: string;
  requestId?: string | null;
}

export interface ExecutionWorkflowResult {
  proposal: TradeProposal;
  execution: Execution;
  order: Order | null;
  fills: Fill[];
  position: Position | null;
  idempotent: boolean;
}

export interface PositionAccountingState {
  quantity: string | null | undefined;
  averageEntryPrice: string | null | undefined;
  realizedPnl: string | null | undefined;
  unrealizedPnl?: string | null;
}

export interface PositionAccountingResult {
  quantity: string;
  averageEntryPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  lastPrice: string | null;
}

function executionKey(proposalId: string): string {
  return `proposal:${proposalId}:attempt:1`;
}

function decimal(value: string | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function proposalSnapshot(proposal: TradeProposal): Record<string, unknown> {
  return {
    id: proposal.id,
    status: proposal.status,
    symbol: proposal.symbol,
    side: proposal.side,
    quantity: proposal.quantity,
    orderType: proposal.orderType,
    limitPrice: proposal.limitPrice,
  };
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

async function existingExecutionResult(
  client: PoolClient,
  proposal: TradeProposal,
  execution: Execution,
): Promise<ExecutionWorkflowResult> {
  const order = await findOrderByExecution(client, execution.id);
  const fills = order ? await findFillsByOrder(client, order.id) : [];
  const position = await findPositionBySymbolForUpdate(client, proposal.symbol);
  return { proposal, execution, order, fills, position, idempotent: true };
}

function executionStatusFromBroker(result: OrderResultDTO): Execution['status'] {
  if (result.status === 'FILLED') return 'FILLED';
  if (result.status === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED';
  if (result.status === 'REJECTED') return 'REJECTED';
  if (result.status === 'ERROR') return 'ERROR';
  if (result.status === 'CANCELLED') return 'CANCELLED';
  return 'SUBMITTED';
}

function proposalStatusFromBroker(result: OrderResultDTO): TradeProposal['status'] {
  if (result.status === 'FILLED') return 'FILLED';
  if (result.status === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED';
  if (result.status === 'REJECTED') return 'EXECUTION_REJECTED';
  if (result.status === 'ERROR') return 'EXECUTION_ERROR';
  if (result.status === 'CANCELLED') return 'CANCELLED';
  return 'SUBMITTED';
}

function averageFillPrice(fills: FillEventDTO[]): string | null {
  const filledQuantity = fills.reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0));
  if (filledQuantity.isZero()) return null;
  const notional = fills.reduce(
    (sum, fill) => sum.plus(decimal(fill.quantity).times(fill.price)),
    new Decimal(0),
  );
  return money(notional.div(filledQuantity));
}

function filledQuantity(fills: FillEventDTO[]): string {
  return money(fills.reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0)));
}

export function calculatePositionAccounting(
  existing: PositionAccountingState | null,
  side: TradeProposal['side'],
  fills: FillEventDTO[],
): PositionAccountingResult {
  let quantity = decimal(existing?.quantity);
  let averageEntryPrice = decimal(existing?.averageEntryPrice);
  let realizedPnl = decimal(existing?.realizedPnl);
  let lastPrice: Decimal | null = null;

  for (const fill of fills) {
    const fillQuantity = decimal(fill.quantity);
    const fillPrice = decimal(fill.price);
    const fee = decimal(fill.fee);
    lastPrice = fillPrice;

    if (side === 'BUY') {
      const currentCost = quantity.times(averageEntryPrice);
      const addedCost = fillQuantity.times(fillPrice).plus(fee);
      quantity = quantity.plus(fillQuantity);
      averageEntryPrice = quantity.isZero()
        ? new Decimal(0)
        : currentCost.plus(addedCost).div(quantity);
    } else {
      realizedPnl = realizedPnl.plus(fillPrice.minus(averageEntryPrice).times(fillQuantity)).minus(fee);
      quantity = quantity.minus(fillQuantity);
      if (quantity.lte(0)) {
        quantity = new Decimal(0);
        averageEntryPrice = new Decimal(0);
      }
    }
  }

  const unrealizedPnl = lastPrice
    ? lastPrice.minus(averageEntryPrice).times(quantity)
    : decimal(existing?.unrealizedPnl);

  return {
    quantity: money(quantity),
    averageEntryPrice: quantity.isZero() ? null : money(averageEntryPrice),
    realizedPnl: money(realizedPnl),
    unrealizedPnl: money(unrealizedPnl),
    lastPrice: lastPrice ? money(lastPrice) : null,
  };
}

async function persistFills(
  client: PoolClient,
  orderId: string,
  brokerFills: FillEventDTO[],
): Promise<Fill[]> {
  const persisted: Fill[] = [];
  for (const fill of brokerFills) {
    const existing = await findFillByBrokerFillId(client, fill.fill_id);
    if (existing) {
      persisted.push(existing);
      continue;
    }
    persisted.push(
      await createFill(client, {
        orderId,
        quantity: fill.quantity,
        price: fill.price,
        fee: fill.fee,
        fillType: fill.is_partial ? 'PARTIAL' : 'FULL',
        brokerFillId: fill.fill_id,
        filledAt: new Date(fill.filled_at),
      }),
    );
  }
  return persisted;
}

async function updatePositionFromFills(
  client: PoolClient,
  proposal: TradeProposal,
  fills: FillEventDTO[],
): Promise<Position | null> {
  if (!fills.length) return findPositionBySymbolForUpdate(client, proposal.symbol);

  const existing = await findPositionBySymbolForUpdate(client, proposal.symbol);
  const accounting = calculatePositionAccounting(existing, proposal.side, fills);

  return upsertPosition(client, {
    symbol: proposal.symbol,
    quantity: accounting.quantity,
    averageEntryPrice: accounting.averageEntryPrice,
    realizedPnl: accounting.realizedPnl,
    unrealizedPnl: accounting.unrealizedPnl,
    lastPrice: accounting.lastPrice ?? existing?.lastPrice,
    lastPriceAt: accounting.lastPrice ? new Date() : existing?.lastPriceAt,
  });
}

async function writePortfolioSnapshot(
  client: PoolClient,
  requestId: string | undefined,
  reason: string,
): Promise<void> {
  const [portfolio, openPositions] = await Promise.all([
    getPaperPortfolio(requestId),
    findOpenPositions(client),
  ]);
  const allPositions = await findAllPositions(client);
  const realizedPnl = allPositions.reduce(
    (sum, position) => sum.plus(position.realizedPnl),
    new Decimal(0),
  );
  const unrealizedPnl = allPositions.reduce(
    (sum, position) => sum.plus(position.unrealizedPnl),
    new Decimal(0),
  );
  const portfolioEquity = decimal(portfolio.cash).plus(
    openPositions.reduce(
      (sum, position) => sum.plus(decimal(position.quantity).times(decimal(position.lastPrice))),
      new Decimal(0),
    ),
  );

  await createSnapshot(client, {
    cashBalance: portfolio.cash,
    portfolioEquity: money(portfolioEquity),
    openPositions,
    pendingOrders: [],
    realizedPnl: money(realizedPnl),
    unrealizedPnl: money(unrealizedPnl),
    dailyPnl: money(realizedPnl),
    snapshotReason: reason,
  });
}

async function assertPaperExecutionAllowed(client: PoolClient): Promise<void> {
  const tradingMode = await getSettingValue<string>(client, 'trading_mode') ?? 'PAPER';
  if (tradingMode !== 'PAPER') {
    throw new ExecutionBlockedError(`Trading mode is not PAPER: ${tradingMode}`, 'TRADING_MODE');
  }

  const killSwitchEnabled = await getSettingValue<boolean>(
    client,
    'trading_kill_switch_enabled',
  ) ?? true;
  if (!killSwitchEnabled) {
    throw new ExecutionBlockedError('Trading kill switch is disabled', 'KILL_SWITCH');
  }
}

export async function executeApprovedProposal(
  pool: Pool,
  proposalId: string,
  actor: ActorContext,
): Promise<ExecutionWorkflowResult> {
  const requestId = actor.requestId ?? undefined;
  const key = executionKey(proposalId);

  return withTransaction(pool, async (client) => {
    const proposal = await findProposalByIdForUpdate(client, proposalId);
    if (!proposal) throw new NotFoundError('Trade proposal not found');

    const existing = await findExecutionByIdempotencyKey(client, key);
    if (existing && existing.status !== 'ERROR') {
      return existingExecutionResult(client, proposal, existing);
    }
    if (existing && await findOrderByExecution(client, existing.id)) {
      return existingExecutionResult(client, proposal, existing);
    }

    if (proposal.expiresAt <= new Date() && proposal.status !== 'EXECUTION_ERROR') {
      assertValidProposalTransition(proposal.status, 'EXPIRED');
      const expired = await updateProposalStatus(client, proposal.id, 'EXPIRED');
      throw new ProposalExpiredError(expired);
    }

    if (proposal.status !== 'APPROVED' && proposal.status !== 'EXECUTION_ERROR') {
      throw new InvalidStateTransitionError(proposal.status, 'SUBMITTING');
    }

    await assertPaperExecutionAllowed(client);

    const execution = existing ?? await createExecution(client, {
      proposalId: proposal.id,
      idempotencyKey: key,
      attemptNumber: 1,
    });

    assertValidProposalTransition(proposal.status, 'SUBMITTING');
    const submitting = await updateProposalStatus(client, proposal.id, 'SUBMITTING');

    let brokerResult: OrderResultDTO;
    try {
      brokerResult = await submitOrder(
        {
          idempotency_key: key,
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: proposal.quantity,
          order_type: proposal.orderType,
          ...(proposal.limitPrice ? { limit_price: proposal.limitPrice } : {}),
        },
        requestId,
      );
    } catch (err) {
      const failedExecution = await updateExecutionStatus(client, execution.id, 'ERROR', {
        errorMessage: (err as Error).message,
      });
      assertValidProposalTransition(submitting.status, 'EXECUTION_ERROR');
      const failedProposal = await updateProposalStatus(client, submitting.id, 'EXECUTION_ERROR');
      await createAuditLog(client, {
        eventType: 'TRADE_EXECUTION_ERROR',
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        entityType: 'trade_proposal',
        entityId: failedProposal.id,
        action: 'SUBMIT_PAPER_ORDER_FAILED',
        beforeData: proposalSnapshot(proposal),
        afterData: { ...proposalSnapshot(failedProposal), error: (err as Error).message },
        requestId,
      });
      return {
        proposal: failedProposal,
        execution: failedExecution,
        order: await findOrderByExecution(client, execution.id),
        fills: [],
        position: await findPositionBySymbolForUpdate(client, proposal.symbol),
        idempotent: false,
      };
    }

    const order = await createOrder(client, {
      executionId: execution.id,
      symbol: proposal.symbol,
      side: proposal.side,
      quantity: proposal.quantity,
      orderType: proposal.orderType,
      limitPrice: proposal.limitPrice,
      brokerOrderId: brokerResult.broker_order_id,
    });
    const persistedFills = await persistFills(client, order.id, brokerResult.fills);
    const updatedOrder = await updateOrderStatus(client, order.id, brokerResult.status, {
      filledQuantity: filledQuantity(brokerResult.fills),
      averageFillPrice: averageFillPrice(brokerResult.fills),
      brokerOrderId: brokerResult.broker_order_id,
    });
    const executionStatus = executionStatusFromBroker(brokerResult);
    const updatedExecution = await updateExecutionStatus(client, execution.id, executionStatus, {
      brokerOrderId: brokerResult.broker_order_id,
      errorMessage: brokerResult.rejected_reason ?? brokerResult.error_message ?? null,
      submittedAt: new Date(),
      completedAt: ['FILLED', 'REJECTED', 'ERROR', 'CANCELLED'].includes(executionStatus)
        ? new Date()
        : null,
    });

    assertValidProposalTransition(submitting.status, 'SUBMITTED');
    const submittedProposal = await updateProposalStatus(client, submitting.id, 'SUBMITTED');
    const nextProposalStatus = proposalStatusFromBroker(brokerResult);
    const finalProposal = nextProposalStatus === 'SUBMITTED'
      ? submittedProposal
      : await updateProposalStatusAfterSubmission(client, submittedProposal, nextProposalStatus);
    const position = await updatePositionFromFills(client, proposal, brokerResult.fills);
    await writePortfolioSnapshot(client, requestId, `TRADE_EXECUTION_${nextProposalStatus}`);

    await createAuditLog(client, {
      eventType: 'TRADE_EXECUTED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: finalProposal.id,
      action: 'SUBMIT_PAPER_ORDER',
      beforeData: proposalSnapshot(proposal),
      afterData: {
        ...proposalSnapshot(finalProposal),
        executionId: updatedExecution.id,
        brokerOrderId: brokerResult.broker_order_id,
      },
      requestId,
    });

    return {
      proposal: finalProposal,
      execution: updatedExecution,
      order: updatedOrder,
      fills: persistedFills,
      position,
      idempotent: false,
    };
  });
}

async function updateProposalStatusAfterSubmission(
  client: PoolClient,
  submittedProposal: TradeProposal,
  nextStatus: TradeProposal['status'],
): Promise<TradeProposal> {
  assertValidProposalTransition(submittedProposal.status, nextStatus);
  return updateProposalStatus(client, submittedProposal.id, nextStatus, {
    filledAt: nextStatus === 'FILLED' ? new Date() : undefined,
  });
}
