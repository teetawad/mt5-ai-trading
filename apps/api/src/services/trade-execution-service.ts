import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import {
  createExecution,
  findExecutionByIdempotencyKey,
  updateExecutionStatus,
} from '../db/repositories/executions';
import { createFill, findFillByBrokerFillId, findFillsByOrder } from '../db/repositories/fills';
import {
  createOrder,
  findOrderByExecution,
  updateOrderStatus,
} from '../db/repositories/orders';
import {
  createSnapshot,
  findLatestSnapshot,
  findLatestSnapshotBefore,
  hasSnapshotOnOrAfter,
} from '../db/repositories/portfolio-snapshots';
import {
  findPositionBySymbolForUpdate,
  findOpenPositions,
  upsertPosition,
} from '../db/repositories/positions';
import { findOpenBracketOrders } from '../db/repositories/orders';
import { getSettingValue } from '../db/repositories/system-settings';
import {
  findProposalByIdForUpdate,
  updateProposalStatus,
} from '../db/repositories/trade-proposals';
import { Execution, Fill, Order, Position, TradeProposal } from '../db/types';
import { assertValidProposalTransition, InvalidStateTransitionError } from './proposal-state-machine';
import {
  FillEventDTO,
  getAllMarketSnapshots,
  getMarketDataStatus,
  getOrder as getBrokerOrder,
  getPaperPortfolio,
  MarketDataStatusDTO,
  MarketSnapshotDTO,
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

export class PositionAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionAccountingError';
  }
}

export interface ActorContext {
  actorId: string | null;
  actorEmail: string;
  requestId?: string | null;
}

export const SYSTEM_RECONCILIATION_ACTOR: ActorContext = {
  actorId: null,
  actorEmail: 'system-reconciliation@internal',
};

export interface ExecutionWorkflowResult {
  proposal: TradeProposal;
  execution: Execution;
  order: Order | null;
  fills: Fill[];
  position: Position | null;
  idempotent: boolean;
}

export type BracketExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'OTHER';

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

export interface PortfolioPnlResult {
  portfolioEquity: string;
  realizedPnl: string;
  unrealizedPnl: string;
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

function bracketFromProposal(proposal: TradeProposal): {
  stop_loss_price: string;
  take_profit_price: string;
} | undefined {
  const phase22 = proposal.riskSnapshot.phase22 as Record<string, unknown> | undefined;
  if (
    proposal.side !== 'BUY'
    || !phase22
    || phase22.orderClass !== 'BRACKET'
    || typeof phase22.stopLoss !== 'string'
    || typeof phase22.takeProfit !== 'string'
  ) {
    return undefined;
  }
  return {
    stop_loss_price: phase22.stopLoss,
    take_profit_price: phase22.takeProfit,
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
      if (fillQuantity.gt(quantity)) {
        throw new PositionAccountingError(
          `SELL fill quantity ${fillQuantity.toString()} exceeds tracked position quantity `
          + `${quantity.toString()}`,
        );
      }
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

export function calculatePortfolioPnl(
  initialCash: string,
  cash: string,
  openPositions: Pick<Position, 'symbol' | 'quantity' | 'averageEntryPrice' | 'lastPrice'>[],
  livePrices: Record<string, string> = {},
): PortfolioPnlResult {
  const priceFor = (position: Pick<Position, 'symbol' | 'lastPrice'>): Decimal => {
    const live = livePrices[position.symbol];
    return live !== undefined ? decimal(live) : decimal(position.lastPrice);
  };
  const positionMarketValue = openPositions.reduce(
    (sum, position) => sum.plus(decimal(position.quantity).times(priceFor(position))),
    new Decimal(0),
  );
  const unrealizedPnl = openPositions.reduce(
    (sum, position) => (
      sum.plus(
        priceFor(position)
          .minus(decimal(position.averageEntryPrice))
          .times(decimal(position.quantity)),
      )
    ),
    new Decimal(0),
  );
  const portfolioEquity = decimal(cash).plus(positionMarketValue);
  const realizedPnl = portfolioEquity.minus(decimal(initialCash)).minus(unrealizedPnl);

  return {
    portfolioEquity: money(portfolioEquity),
    realizedPnl: money(realizedPnl),
    unrealizedPnl: money(unrealizedPnl),
  };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getDayStartEquity(
  db: Pool | PoolClient,
  now: Date,
  fallbackInitialCash: string,
): Promise<Decimal> {
  const baseline = await findLatestSnapshotBefore(db, startOfUtcDay(now));
  return baseline ? decimal(baseline.portfolioEquity) : decimal(fallbackInitialCash);
}

/**
 * Guarantees a snapshot exists for "today" (UTC) so getDayStartEquity's
 * "latest snapshot strictly before today" lookup never has to fall back to
 * a stale snapshot from several days ago just because no trade happened
 * since. Snapshots are otherwise only written on trade/bracket-exit events
 * (see writePortfolioSnapshot), so a quiet multi-day-open position would
 * otherwise leave "Daily P&L" silently measuring P&L since the last trade
 * instead of P&L since today's open. Idempotent per UTC day: a no-op once
 * any snapshot (trade-triggered or this DAY_OPEN marker) exists for today.
 */
export async function ensureDayStartSnapshot(
  pool: Pool,
  view: Pick<LivePortfolioView, 'cashBalance' | 'portfolioEquity' | 'realizedPnl' | 'unrealizedPnl' | 'positions'>,
): Promise<void> {
  const todayStart = startOfUtcDay(new Date());
  if (await hasSnapshotOnOrAfter(pool, todayStart)) return;
  await createSnapshot(pool, {
    cashBalance: view.cashBalance,
    portfolioEquity: view.portfolioEquity,
    openPositions: view.positions,
    pendingOrders: [],
    realizedPnl: view.realizedPnl,
    unrealizedPnl: view.unrealizedPnl,
    dailyPnl: '0.00000000',
    snapshotReason: 'DAY_OPEN',
  });
}

export interface LiveMarketData {
  prices: Record<string, string>;
  timestamps: Record<string, string>;
  staleSymbols: Set<string>;
  snapshots: MarketSnapshotDTO[];
  /** Set when the underlying getAllMarketSnapshots call failed, so callers
   * that need to distinguish "no tracked symbols" from "fetch failed" (e.g.
   * for an external-reachability status field) don't have to fetch twice. */
  fetchError: unknown;
}

export async function liveMarketData(requestId: string | undefined): Promise<LiveMarketData> {
  try {
    const snapshots = await getAllMarketSnapshots(requestId);
    const prices: Record<string, string> = {};
    const timestamps: Record<string, string> = {};
    const staleSymbols = new Set<string>();
    for (const snapshot of snapshots) {
      prices[snapshot.symbol] = snapshot.price;
      timestamps[snapshot.symbol] = snapshot.timestamp;
      if (snapshot.is_stale) staleSymbols.add(snapshot.symbol);
    }
    return { prices, timestamps, staleSymbols, snapshots, fetchError: null };
  } catch (err) {
    return { prices: {}, timestamps: {}, staleSymbols: new Set(), snapshots: [], fetchError: err };
  }
}

export async function livePriceMap(requestId: string | undefined): Promise<Record<string, string>> {
  return (await liveMarketData(requestId)).prices;
}

export interface LivePosition extends Position {
  isStale: boolean;
  priceAsOf: string | null;
  /** quantity * current lastPrice, computed once here so every page (Dashboard,
   * Positions, Portfolio) shows the same figure instead of each re-deriving it. */
  marketValue: string;
}

export interface LivePortfolioView {
  cashBalance: string;
  portfolioEquity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  positions: LivePosition[];
  marketDataStatus: MarketDataStatusDTO;
  marketSnapshots: MarketSnapshotDTO[];
  marketFetchError: unknown;
  asOf: string;
}

const DISCONNECTED_STATUS: MarketDataStatusDTO = {
  mode: 'poll',
  connected: false,
  last_message_at: null,
};

export function mergeLivePosition(position: Position, market: LiveMarketData): LivePosition {
  const livePrice = market.prices[position.symbol];
  const priceKnown = livePrice !== undefined;
  const lastPrice = priceKnown ? livePrice : position.lastPrice;
  const unrealizedPnl = lastPrice && position.averageEntryPrice
    ? money(decimal(lastPrice).minus(decimal(position.averageEntryPrice)).times(decimal(position.quantity)))
    : position.unrealizedPnl;
  return {
    ...position,
    lastPrice: lastPrice ?? position.lastPrice,
    unrealizedPnl,
    isStale: !priceKnown || market.staleSymbols.has(position.symbol),
    priceAsOf: market.timestamps[position.symbol]
      ?? (position.lastPriceAt ? position.lastPriceAt.toISOString() : null),
    marketValue: lastPrice ? money(decimal(lastPrice).times(decimal(position.quantity))) : '0.00000000',
  };
}

/**
 * Read-only, on-demand view of the portfolio and open positions priced at
 * current market data. Never writes to the database — positions.last_price
 * and portfolio_snapshots are only ever updated by actual trade/bracket-exit
 * events (see writePortfolioSnapshot / updatePositionFromFills). This is the
 * single source both the positions route and the dashboard route read from,
 * so they can never disagree.
 */
export async function getLivePortfolioView(
  pool: Pool,
  requestId: string | undefined,
): Promise<LivePortfolioView> {
  const [paperPortfolioResult, openPositions, market, marketDataStatus, initialCashSetting] = await Promise.all([
    getPaperPortfolio(requestId).catch(() => null),
    findOpenPositions(pool),
    liveMarketData(requestId),
    getMarketDataStatus(requestId).catch(() => DISCONNECTED_STATUS),
    getSettingValue(pool, 'initial_paper_cash_usd'),
  ]);
  const initialCash = String(initialCashSetting ?? '100000');
  // Broker/paper-portfolio unavailability must not take the positions/dashboard
  // routes down with it — fall back to the last persisted cash figure so the
  // page still renders (with live prices) instead of 500ing.
  const paperPortfolio = paperPortfolioResult
    ?? { cash: (await findLatestSnapshot(pool))?.cashBalance ?? initialCash, positions: {} };
  const pnl = calculatePortfolioPnl(initialCash, paperPortfolio.cash, openPositions, market.prices);
  const positions = openPositions.map((position) => mergeLivePosition(position, market));

  return {
    cashBalance: paperPortfolio.cash,
    portfolioEquity: pnl.portfolioEquity,
    realizedPnl: pnl.realizedPnl,
    unrealizedPnl: pnl.unrealizedPnl,
    positions,
    marketDataStatus,
    marketSnapshots: market.snapshots,
    marketFetchError: market.fetchError,
    asOf: new Date().toISOString(),
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
  const [portfolio, openPositions, livePrices] = await Promise.all([
    getPaperPortfolio(requestId),
    findOpenPositions(client),
    livePriceMap(requestId),
  ]);
  const initialCash = String(await getSettingValue(client, 'initial_paper_cash_usd') ?? '100000');
  const pnl = calculatePortfolioPnl(initialCash, portfolio.cash, openPositions, livePrices);
  const now = new Date();
  const dayStartEquity = await getDayStartEquity(client, now, initialCash);
  const dailyPnl = decimal(pnl.portfolioEquity).minus(dayStartEquity);

  await createSnapshot(client, {
    cashBalance: portfolio.cash,
    portfolioEquity: pnl.portfolioEquity,
    openPositions,
    pendingOrders: [],
    realizedPnl: pnl.realizedPnl,
    unrealizedPnl: pnl.unrealizedPnl,
    dailyPnl: money(dailyPnl),
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
          ...(bracketFromProposal(proposal) ? { bracket: bracketFromProposal(proposal) } : {}),
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
      bracketOrderIds: brokerResult.bracket_order_ids ?? (
        bracketFromProposal(proposal)
          ? {
            parent: brokerResult.broker_order_id,
            take_profit: null,
            stop_loss: null,
          }
          : {}
      ),
    });
    const persistedFills = await persistFills(client, order.id, brokerResult.fills);
    const updatedOrder = await updateOrderStatus(client, order.id, brokerResult.status, {
      filledQuantity: filledQuantity(brokerResult.fills),
      averageFillPrice: averageFillPrice(brokerResult.fills),
      brokerOrderId: brokerResult.broker_order_id,
      bracketOrderIds: brokerResult.bracket_order_ids,
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

    const bracket = bracketFromProposal(proposal);
    if (bracket) {
      // Bracket (stop-loss/take-profit) entry creation was previously only
      // visible by inspecting the nested phase22 JSON on TRADE_EXECUTED —
      // give it its own queryable event, matching BRACKET_EXIT_RECONCILED
      // below which already covers the exit side.
      await createAuditLog(client, {
        eventType: 'BRACKET_ORDER_CREATED',
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        entityType: 'trade_proposal',
        entityId: finalProposal.id,
        action: 'CREATE_BRACKET_ENTRY',
        afterData: {
          orderId: updatedOrder.id,
          brokerOrderId: brokerResult.broker_order_id,
          bracketOrderIds: brokerResult.bracket_order_ids ?? null,
          stopLossPrice: bracket.stop_loss_price,
          takeProfitPrice: bracket.take_profit_price,
        },
        requestId,
      });
    }

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

export async function recordApprovedBracketExit(
  pool: Pool,
  proposalId: string,
  exitReason: BracketExitReason,
  fill: FillEventDTO,
  actor: ActorContext,
): Promise<ExecutionWorkflowResult> {
  return withTransaction(pool, async (client) => {
    const proposal = await findProposalByIdForUpdate(client, proposalId);
    if (!proposal) throw new NotFoundError('Trade proposal not found');
    const execution = await findExecutionByIdempotencyKey(client, executionKey(proposal.id));
    if (!execution) throw new NotFoundError('Trade execution not found');
    const order = await findOrderByExecution(client, execution.id);
    if (!order) throw new NotFoundError('Bracket parent order not found');
    const phase22 = proposal.riskSnapshot.phase22 as Record<string, unknown> | undefined;
    if (proposal.side !== 'BUY' || phase22?.orderClass !== 'BRACKET') {
      throw new InvalidStateTransitionError(proposal.status, 'FILLED');
    }

    const existingFill = await findFillByBrokerFillId(client, fill.fill_id);
    if (existingFill) {
      return existingExecutionResult(client, proposal, execution);
    }

    const exitOrder = await createOrder(client, {
      executionId: execution.id,
      symbol: proposal.symbol,
      side: 'SELL',
      quantity: fill.quantity,
      orderType: 'MARKET',
      brokerOrderId: fill.order_id,
      bracketOrderIds: {
        ...order.bracketOrderIds,
        cancelled_leg: exitReason === 'TAKE_PROFIT' ? 'stop_loss' : 'take_profit',
      },
    });
    const persistedFills = await persistFills(client, exitOrder.id, [fill]);
    const updatedOrder = await updateOrderStatus(client, exitOrder.id, 'FILLED', {
      filledQuantity: fill.quantity,
      averageFillPrice: fill.price,
      brokerOrderId: fill.order_id,
      exitReason,
      bracketOrderIds: {
        ...order.bracketOrderIds,
        filled_leg: exitReason === 'TAKE_PROFIT' ? 'take_profit' : 'stop_loss',
        cancelled_leg: exitReason === 'TAKE_PROFIT' ? 'stop_loss' : 'take_profit',
      },
    });
    const position = await updatePositionFromFills(client, { ...proposal, side: 'SELL' }, [fill]);
    await writePortfolioSnapshot(client, actor.requestId ?? undefined, `BRACKET_EXIT_${exitReason}`);
    await createAuditLog(client, {
      eventType: 'BRACKET_EXIT_RECONCILED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'trade_proposal',
      entityId: proposal.id,
      action: `RECORD_${exitReason}_EXIT`,
      beforeData: proposalSnapshot(proposal),
      afterData: { exitReason, fill, cancelledLeg: exitReason === 'TAKE_PROFIT' ? 'stop_loss' : 'take_profit' },
      requestId: actor.requestId ?? null,
    });

    return {
      proposal,
      execution,
      order: updatedOrder,
      fills: persistedFills,
      position,
      idempotent: false,
    };
  });
}

export interface BracketReconciliationResult {
  checked: number;
  reconciled: number;
  errors: number;
}

/**
 * Polls the broker for every locally-open bracket order (entry filled, no
 * exit recorded yet) and records the exit locally when a leg has filled.
 *
 * Alpaca hosts the SL/TP OCO server-side, so a filled leg is invisible to
 * this app until something polls for it — this is that poll. Safe to call
 * repeatedly (recordApprovedBracketExit is idempotent per broker fill_id) and
 * safe to call with brackets that are still pending (no-op for those).
 * Never throws: one bracket's broker error must not block the others or the
 * caller (dashboard load / startup) that triggered reconciliation.
 */
export async function reconcileBracketOrders(
  pool: Pool,
  actor: ActorContext = SYSTEM_RECONCILIATION_ACTOR,
  requestId?: string,
): Promise<BracketReconciliationResult> {
  const result: BracketReconciliationResult = { checked: 0, reconciled: 0, errors: 0 };
  let openBrackets: Awaited<ReturnType<typeof findOpenBracketOrders>>;
  try {
    openBrackets = await findOpenBracketOrders(pool);
  } catch {
    return result;
  }

  for (const bracket of openBrackets) {
    const takeProfitId = bracket.bracketOrderIds.take_profit;
    const stopLossId = bracket.bracketOrderIds.stop_loss;
    if (!takeProfitId || !stopLossId) continue;
    result.checked += 1;

    try {
      const [takeProfitResult, stopLossResult] = await Promise.all([
        getBrokerOrder(takeProfitId, requestId),
        getBrokerOrder(stopLossId, requestId),
      ]);

      const filledLeg = takeProfitResult?.status === 'FILLED'
        ? { exitReason: 'TAKE_PROFIT' as const, order: takeProfitResult }
        : stopLossResult?.status === 'FILLED'
          ? { exitReason: 'STOP_LOSS' as const, order: stopLossResult }
          : null;
      if (!filledLeg || filledLeg.order.fills.length === 0) continue;

      await recordApprovedBracketExit(
        pool,
        bracket.proposalId,
        filledLeg.exitReason,
        filledLeg.order.fills[0],
        actor,
      );
      result.reconciled += 1;
    } catch {
      result.errors += 1;
    }
  }

  return result;
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
