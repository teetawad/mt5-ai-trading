import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import { findLatestFillBySymbol } from '../db/repositories/fills';
import { findActiveOrdersBySymbol } from '../db/repositories/orders';
import { findLatestSnapshot } from '../db/repositories/portfolio-snapshots';
import { createRiskCheck, linkRiskCheckToProposal } from '../db/repositories/risk-checks';
import { createSignal, updateSignalStatus } from '../db/repositories/signals';
import { findStrategyById, upsertStrategy } from '../db/repositories/strategies';
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
  getTrackedSymbols,
} from './trading-engine-client';
import { assertValidProposalTransition, InvalidStateTransitionError } from './proposal-state-machine';
import { AiDecision, analyzeUsStock } from './ai-decision-service';

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
  aiDecision?: AiDecision | null;
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

export interface CreateManualTestSignalInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
}

export interface CreateAiDecisionInput {
  symbol: string;
  side?: 'BUY' | 'SELL' | 'HOLD';
  quantity?: string;
}

export interface AiDecisionWorkflowResult {
  aiDecision: AiDecision;
  signal: Signal | null;
  riskCheck: RiskCheck | null;
  riskResult: RiskResultDTO | null;
  proposal: TradeProposal | null;
}

export interface ApprovalWorkflowResult {
  proposal: TradeProposal;
  approval: TradeApproval;
  riskCheck?: RiskCheck;
  riskResult?: RiskResultDTO;
  idempotent: boolean;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const MANUAL_TEST_STRATEGY_NAME = 'MANUAL_TEST_PAPER_ONLY';
const AI_ASSISTED_STRATEGY_NAME = 'AI_ASSISTED_PAPER_ONLY';
const SUPPORTED_US_STOCK_PATTERN = /^[A-Z]{1,5}(\.[A-Z])?$/;
const EIGHT_DP = 8;

function validatePositiveDecimal(value: string, field: string): void {
  if (!DECIMAL_PATTERN.test(value) || new Decimal(value).lte(0)) {
    throw new ValidationError(`${field} must be a positive decimal string`);
  }
}

function validateSide(value: unknown): asserts value is 'BUY' | 'SELL' {
  if (value !== 'BUY' && value !== 'SELL') {
    throw new ValidationError('side must be BUY or SELL');
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

  const cfg = {
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
    phase22_stop_loss_pct: String(await getSettingValue(db, 'phase22_stop_loss_pct') ?? '2'),
    phase22_take_profit_pct: String(await getSettingValue(db, 'phase22_take_profit_pct') ?? '4'),
    phase22_max_loss_per_trade_usd: String(
      await getSettingValue(db, 'phase22_max_loss_per_trade_usd') ?? '100',
    ),
    phase22_max_bid_ask_spread_pct: String(
      await getSettingValue(db, 'phase22_max_bid_ask_spread_pct') ?? '0.5',
    ),
    phase22_estimated_slippage_pct: String(
      await getSettingValue(db, 'phase22_estimated_slippage_pct') ?? '0.05',
    ),
    phase22_max_estimated_slippage_pct: String(
      await getSettingValue(db, 'phase22_max_estimated_slippage_pct') ?? '0.25',
    ),
    phase22_prevent_duplicate_exposure:
      await getSettingValue<boolean>(db, 'phase22_prevent_duplicate_exposure') ?? true,
    proposal_ttl_seconds: parseTtlSeconds(await getSettingValue(db, 'proposal_ttl_seconds')),
    trading_session_start:
      await getSettingValue<string | null>(db, 'trading_session_start') ?? undefined,
    trading_session_end:
      await getSettingValue<string | null>(db, 'trading_session_end') ?? undefined,
    cooldown_between_trades_seconds:
      Number(await getSettingValue(db, 'cooldown_between_trades_seconds') ?? 0),
  };
  return cfg;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(EIGHT_DP).toFixed(EIGHT_DP);
}

function decimal(value: string | number | null | undefined): Decimal {
  return new Decimal(value ?? '0');
}

function phase22Rules(cfg: RiskConfigDTO) {
  return {
    stopLossPct: decimal(cfg.phase22_stop_loss_pct),
    takeProfitPct: decimal(cfg.phase22_take_profit_pct),
    maxLossPerTradeUsd: decimal(cfg.phase22_max_loss_per_trade_usd),
    maxSpreadPct: decimal(cfg.phase22_max_bid_ask_spread_pct),
    estimatedSlippagePct: decimal(cfg.phase22_estimated_slippage_pct),
    maxEstimatedSlippagePct: decimal(cfg.phase22_max_estimated_slippage_pct),
    preventDuplicateExposure: cfg.phase22_prevent_duplicate_exposure !== false,
    cooldownSeconds: Number(cfg.cooldown_between_trades_seconds ?? 0),
    maxDailyLossUsd: decimal(cfg.max_daily_loss_usd),
    maxOrderNotionalUsd: decimal(cfg.max_order_notional_usd),
    maxPositionSizeUsd: decimal(cfg.max_position_size_usd),
    maxConcentrationPct: decimal(cfg.max_portfolio_concentration_pct),
  };
}

async function phase22RiskControls(
  client: PoolClient,
  input: {
    symbol: string;
    side: 'BUY' | 'SELL';
    requestedQuantity: string;
    entryPrice: string;
    market: { price: string; bid: string; ask: string; is_stale: boolean; timestamp: string };
    paperPortfolio: { cash: string; positions: Record<string, string> };
    latestSnapshot: { portfolioEquity: string; dailyPnl: string } | null;
    cfg: RiskConfigDTO;
    excludeProposalId?: string;
  },
): Promise<{
  quantity: string;
  estimatedNotional: string;
  passed: boolean;
  failedRules: string[];
  reason: string | null;
  snapshot: Record<string, unknown>;
}> {
  const rules = phase22Rules(input.cfg);
  const entry = decimal(input.entryPrice);
  const bid = decimal(input.market.bid);
  const ask = decimal(input.market.ask);
  const mid = bid.plus(ask).div(2);
  const spreadPct = mid.gt(0) ? ask.minus(bid).div(mid).mul(100) : new Decimal(0);
  const slippagePct = rules.estimatedSlippagePct;
  const stopLoss = input.side === 'BUY'
    ? entry.mul(new Decimal(1).minus(rules.stopLossPct.div(100)))
    : entry.mul(new Decimal(1).plus(rules.stopLossPct.div(100)));
  const takeProfit = input.side === 'BUY'
    ? entry.mul(new Decimal(1).plus(rules.takeProfitPct.div(100)))
    : entry.mul(new Decimal(1).minus(rules.takeProfitPct.div(100)));
  const riskPerShare = entry.minus(stopLoss).abs();
  const requestedQuantity = decimal(input.requestedQuantity);
  const cash = decimal(input.paperPortfolio.cash);
  const equity = decimal(input.latestSnapshot?.portfolioEquity ?? input.paperPortfolio.cash);
  const dailyPnl = decimal(input.latestSnapshot?.dailyPnl);
  const existingQty = decimal(input.paperPortfolio.positions[input.symbol]);
  const slippagePerShare = entry.mul(slippagePct.div(100));
  const estimatedFeePerShare = new Decimal('0.005');
  const minFee = new Decimal('1');
  let riskQuantity = riskPerShare.gt(0)
    ? rules.maxLossPerTradeUsd.div(riskPerShare.plus(slippagePerShare).plus(estimatedFeePerShare))
    : new Decimal(0);
  if (input.side !== 'BUY') riskQuantity = requestedQuantity;
  const cashQuantity = entry.plus(slippagePerShare).gt(0)
    ? cash.div(entry.plus(slippagePerShare))
    : new Decimal(0);
  const positionLimitQuantity = rules.maxPositionSizeUsd.div(entry);
  const concentrationQuantity = equity.gt(0)
    ? equity.mul(rules.maxConcentrationPct.div(100)).div(entry)
    : riskQuantity;
  const rawQuantity = input.side === 'BUY'
    ? Decimal.min(requestedQuantity, riskQuantity, cashQuantity, positionLimitQuantity, concentrationQuantity)
    : requestedQuantity;
  const quantity = rawQuantity.toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const estimatedFee = Decimal.max(quantity.mul(estimatedFeePerShare), minFee);
  const estimatedSlippageUsd = quantity.mul(slippagePerShare);
  const maxLoss = quantity.mul(riskPerShare).plus(estimatedSlippageUsd).plus(estimatedFee);
  const riskReward = riskPerShare.gt(0) ? takeProfit.minus(entry).abs().div(riskPerShare) : new Decimal(0);
  const activeOrders = await findActiveOrdersBySymbol(client, input.symbol);
  const activeExposure = await findActiveExposureProposals(client, input.excludeProposalId);
  const latestFill = await findLatestFillBySymbol(client, input.symbol);
  const cooldownRemaining = latestFill && rules.cooldownSeconds > 0
    ? Math.max(0, rules.cooldownSeconds - Math.floor((Date.now() - latestFill.filledAt.getTime()) / 1000))
    : 0;
  const failedRules: string[] = [];

  if (input.market.is_stale) failedRules.push('PHASE22_FRESH_MARKET_DATA');
  if (spreadPct.gt(rules.maxSpreadPct)) failedRules.push('PHASE22_BID_ASK_SPREAD');
  if (slippagePct.gt(rules.maxEstimatedSlippagePct)) failedRules.push('PHASE22_ESTIMATED_SLIPPAGE');
  if (activeOrders.length > 0) failedRules.push('PHASE22_DUPLICATE_PENDING_ORDER');
  if (
    rules.preventDuplicateExposure
    && input.side === 'BUY'
    && (existingQty.gt(0) || activeExposure.some((proposal) => proposal.symbol === input.symbol))
  ) {
    failedRules.push('PHASE22_DUPLICATE_EXPOSURE');
  }
  if (cooldownRemaining > 0) failedRules.push('PHASE22_COOLDOWN');
  if (dailyPnl.lt(rules.maxDailyLossUsd.neg())) failedRules.push('PHASE22_MAX_DAILY_LOSS');
  if (maxLoss.gt(rules.maxLossPerTradeUsd)) failedRules.push('PHASE22_MAX_LOSS_PER_TRADE');
  if (quantity.lte(0)) failedRules.push('PHASE22_POSITION_SIZE');

  const snapshot = {
    phase: '22',
    source: 'SERVER_SIDE_RISK_CONTROLS',
    orderClass: input.side === 'BUY' ? 'BRACKET' : 'SINGLE',
    entry: money(entry),
    stopLoss: money(stopLoss),
    takeProfit: money(takeProfit),
    riskReward: money(riskReward),
    requestedQuantity: money(requestedQuantity),
    quantity: money(quantity),
    maxLoss: money(maxLoss),
    riskBudget: money(rules.maxLossPerTradeUsd),
    spreadPct: money(spreadPct),
    estimatedSlippagePct: money(slippagePct),
    estimatedSlippageUsd: money(estimatedSlippageUsd),
    dailyLossUsed: money(dailyPnl.lt(0) ? dailyPnl.abs() : new Decimal(0)),
    dailyLossLimit: money(rules.maxDailyLossUsd),
    cooldown: {
      configuredSeconds: rules.cooldownSeconds,
      remainingSeconds: cooldownRemaining,
      passed: cooldownRemaining === 0,
    },
    duplicateExposurePrevented: rules.preventDuplicateExposure,
    conflictingPendingOrders: activeOrders.map((order) => ({
      id: order.id,
      brokerOrderId: order.brokerOrderId,
      status: order.status,
    })),
    failedRules,
    result: failedRules.length ? 'REJECT' : 'PASS',
  };

  return {
    quantity: money(quantity),
    estimatedNotional: money(quantity.mul(entry)),
    passed: failedRules.length === 0,
    failedRules,
    reason: failedRules.length ? `Phase 22 risk controls failed: ${failedRules.join(', ')}` : null,
    snapshot,
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
    phase22: proposal.riskSnapshot.phase22 ?? null,
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
  validateSide(input.side);
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
    const phase22 = await phase22RiskControls(client, {
      symbol,
      side: input.side,
      requestedQuantity: input.quantity,
      entryPrice: market.price,
      market,
      paperPortfolio,
      latestSnapshot,
      cfg,
    });
    const proposalQuantity = phase22.quantity;
    const estimatedNotional = phase22.estimatedNotional;

    const signal = await createSignal(client, {
      strategyId: strategy.id,
      symbol,
      side: input.side,
      referencePrice,
      reason: input.reason.trim(),
      strategyVersion: strategy.version,
      confidence: input.confidence ?? null,
      marketSnapshot: input.aiDecision ? { ...market, aiDecision: input.aiDecision } : { ...market },
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
          quantity: proposalQuantity,
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
    const combinedFailedRules = [
      ...riskResult.failed_rules,
      ...phase22.failedRules,
    ];
    const combinedRiskResult = {
      ...riskResult,
      result: (riskResult.result === 'PASS' && phase22.passed ? 'PASS' : 'REJECT') as RiskResultDTO['result'],
      failed_rules: combinedFailedRules,
      reason: [riskResult.reason, phase22.reason].filter(Boolean).join('; ') || null,
      aiDecision: input.aiDecision ?? null,
      phase22: phase22.snapshot,
    };

    const riskCheck = await createRiskCheck(client, {
      signalId: signal.id,
      stage: 'PRE_PROPOSAL',
      result: combinedRiskResult.result,
      rulesChecked: [...riskResult.rules_checked, 'PHASE22_ADVANCED_RISK_CONTROLS'],
      failedRules: combinedFailedRules,
      reason: combinedRiskResult.reason,
      marketSnapshot: { ...riskResult.market_snapshot },
      portfolioSnapshot: { ...riskResult.portfolio_snapshot },
    });

    const proposal = await createProposal(client, {
      signalId: signal.id,
      strategyId: strategy.id,
      symbol,
      side: input.side,
      quantity: proposalQuantity,
      orderType,
      referencePrice,
      limitPrice: orderType === 'LIMIT' ? input.limitPrice : null,
      estimatedNotional,
      riskCheckId: riskCheck.id,
      riskSnapshot: combinedRiskResult as unknown as Record<string, unknown>,
      portfolioSnapshot: { ...riskResult.portfolio_snapshot },
      expiresAt,
    });

    await linkRiskCheckToProposal(client, riskCheck.id, proposal.id);

    const nextStatus = combinedRiskResult.result === 'PASS' ? 'PENDING_APPROVAL' : 'RISK_REJECTED';
    assertValidProposalTransition(proposal.status, nextStatus);
    const finalProposal = await updateProposalStatus(
      client,
      proposal.id,
      nextStatus,
      nextStatus === 'PENDING_APPROVAL' ? { pendingApprovalAt: new Date() } : {},
    );
    const signalStatus = combinedRiskResult.result === 'PASS' ? 'RISK_PASS' : 'RISK_FAIL';
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
      riskResult: combinedRiskResult,
      proposal: finalProposal,
    };
  });
}

export async function manualTestSignalOptions(requestId?: string | null): Promise<{ symbols: string[] }> {
  const symbols = await getTrackedSymbols(requestId ?? undefined);
  return {
    symbols: symbols
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol) => SUPPORTED_US_STOCK_PATTERN.test(symbol))
      .sort(),
  };
}

export async function createManualTestSignalAndProposal(
  pool: Pool,
  input: CreateManualTestSignalInput,
  actor: ActorContext,
): Promise<CreateSignalWorkflowResult> {
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  validateSide(input.side);
  validatePositiveDecimal(String(input.quantity ?? ''), 'quantity');
  if (!SUPPORTED_US_STOCK_PATTERN.test(symbol)) {
    throw new ValidationError('symbol must be a supported US stock symbol');
  }

  const { symbols } = await manualTestSignalOptions(actor.requestId);
  if (!symbols.includes(symbol)) {
    throw new NotFoundError(`Symbol not supported for PAPER manual tests: ${symbol}`);
  }
  const tradingMode = await getSettingValue<string>(pool, 'trading_mode');
  if ((tradingMode ?? 'PAPER') !== 'PAPER') {
    throw new ValidationError('manual test signals are available in PAPER mode only');
  }

  const strategy = await upsertStrategy(pool, {
    name: MANUAL_TEST_STRATEGY_NAME,
    description: 'MANUAL TEST / PAPER ONLY signal entry. Uses server-side market data and the normal risk/proposal workflow.',
    version: '1.0.0',
    parameters: { source: 'manual_test', tradingMode: 'PAPER' },
    isActive: true,
  });

  return createSignalAndProposal(
    pool,
    {
      strategyId: strategy.id,
      symbol,
      side: input.side,
      quantity: String(input.quantity),
      orderType: 'MARKET',
      reason: 'MANUAL TEST / PAPER ONLY',
      confidence: null,
    },
    actor,
  );
}

export async function createAiDecisionAndProposal(
  pool: Pool,
  input: CreateAiDecisionInput,
  actor: ActorContext,
): Promise<AiDecisionWorkflowResult> {
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  if (!SUPPORTED_US_STOCK_PATTERN.test(symbol)) {
    throw new ValidationError('symbol must be a supported US stock symbol');
  }
  if (input.side !== undefined && !['BUY', 'SELL', 'HOLD'].includes(input.side)) {
    throw new ValidationError('side must be BUY, SELL, or HOLD');
  }
  const quantity = String(input.quantity ?? '1.00000000');
  validatePositiveDecimal(quantity, 'quantity');
  const tradingMode = await getSettingValue<string>(pool, 'trading_mode');
  if ((tradingMode ?? 'PAPER') !== 'PAPER') {
    throw new ValidationError('AI-assisted signals are available in PAPER mode only');
  }

  const market = await getMarketSnapshot(symbol, actor.requestId ?? undefined);
  if (!market) throw new NotFoundError(`Symbol not found: ${symbol}`);
  const aiDecision = analyzeUsStock(market, {
    requestedSide: input.side,
    requestedQuantity: quantity,
  });

  if (aiDecision.decision === 'HOLD') {
    await createAuditLog(pool, {
      eventType: 'AI_DECISION_HOLD',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'signal',
      entityId: null,
      action: 'AI_HOLD_NO_TRADE',
      afterData: { aiDecision },
      requestId: actor.requestId ?? null,
    });
    return { aiDecision, signal: null, riskCheck: null, riskResult: null, proposal: null };
  }

  const strategy = await upsertStrategy(pool, {
    name: AI_ASSISTED_STRATEGY_NAME,
    description: 'AI-assisted PAPER ONLY US stock decision layer. Never submits broker orders.',
    version: aiDecision.strategyVersion,
    parameters: { source: 'ai_assisted', model: aiDecision.model, tradingMode: 'PAPER' },
    isActive: true,
  });

  const result = await createSignalAndProposal(pool, {
    strategyId: strategy.id,
    symbol,
    side: aiDecision.decision,
    quantity: aiDecision.suggestedPositionSize,
    orderType: 'MARKET',
    referencePrice: aiDecision.proposedEntry,
    reason: `AI DECISION / PAPER ONLY: ${aiDecision.decision}`,
    confidence: aiDecision.confidence,
    aiDecision,
  }, actor);

  return { aiDecision, ...result };
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
    const phase22 = await phase22RiskControls(client, {
      symbol: proposal.symbol,
      side: proposal.side,
      requestedQuantity: proposal.quantity,
      entryPrice: market.price,
      market,
      paperPortfolio,
      latestSnapshot,
      cfg,
      excludeProposalId: proposal.id,
    });

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
    const combinedFailedRules = [
      ...riskResult.failed_rules,
      ...phase22.failedRules,
    ];
    const combinedRiskResult = {
      ...riskResult,
      result: (riskResult.result === 'PASS' && phase22.passed ? 'PASS' : 'REJECT') as RiskResultDTO['result'],
      failed_rules: combinedFailedRules,
      reason: [riskResult.reason, phase22.reason].filter(Boolean).join('; ') || null,
      phase22: phase22.snapshot,
    };

    const riskCheck = await createRiskCheck(client, {
      signalId: proposal.signalId,
      proposalId: proposal.id,
      stage: 'PRE_EXECUTION',
      result: combinedRiskResult.result,
      rulesChecked: [...riskResult.rules_checked, 'PHASE22_ADVANCED_RISK_CONTROLS'],
      failedRules: combinedFailedRules,
      reason: combinedRiskResult.reason,
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

    if (combinedRiskResult.result === 'REJECT') {
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
        riskResult: combinedRiskResult,
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

    return { proposal: approved, approval, riskCheck, riskResult: combinedRiskResult, idempotent: false };
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
