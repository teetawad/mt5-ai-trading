import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { createAuditLog } from '../db/repositories/audit-logs';
import {
  checkMt5Order,
  getMt5HistoryDeals,
  getMt5MarketStatus,
  getMt5Status,
  getMt5SymbolInfo,
  getMt5Tick,
  listMt5PendingOrders,
  listMt5Positions,
  sendMt5Order,
  Mt5DecisionDTO,
  Mt5OrderRequestDTO,
} from './mt5-client';
import { evaluateMt5Risk, normalizeVolume, toRiskSymbolInfo } from './mt5-risk-engine';
import { loadMt5RiskSettings } from '../config/mt5-risk-settings';

// ---------------------------------------------------------------------------
// This module is the single EntryPlanWatcher. It is the ONLY place in the
// Node API that transitions an mt5_entry_plans row toward execution and the
// ONLY caller of checkMt5Order/sendMt5Order (which themselves call the Python
// DemoExecutionGateway — the only order_send() caller in the whole codebase).
//
// It is deliberately separate from the H1 AI strategy scheduler
// (mt5-hourly-scheduler.ts): the H1 scheduler creates/refreshes AI decisions
// and entry plans from completed candles; this watcher only ever monitors an
// already-created plan against live price and decides WAITING -> TRIGGERED ->
// EXECUTING -> EXECUTED, independent of whether an H1 candle just closed.
// ---------------------------------------------------------------------------

export type EntryStrategy = 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT' | 'NO_ENTRY';
export type EntryStatus =
  | 'WAITING'
  | 'READY'
  | 'TRIGGERED'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'RECONCILIATION_FAILED';

export interface Mt5Actor {
  actorId: string | null;
  actorEmail: string;
  requestId?: string | null;
}

// Strict entry-plan state machine. A transition is legal only if the target
// status appears in the source status's list. EXECUTED/EXPIRED/CANCELLED are
// terminal — nothing (including EXECUTING) may leave them.
const VALID_TRANSITIONS: Record<EntryStatus, EntryStatus[]> = {
  WAITING: ['READY', 'TRIGGERED', 'EXPIRED', 'CANCELLED', 'BLOCKED'],
  READY: ['TRIGGERED', 'EXECUTING', 'EXPIRED', 'CANCELLED', 'BLOCKED', 'WAITING'],
  TRIGGERED: ['EXECUTING', 'EXPIRED', 'CANCELLED', 'BLOCKED'],
  EXECUTING: ['EXECUTED', 'BLOCKED', 'TRIGGERED'], // TRIGGERED only via crash reconciliation release
  // A plan that looked EXECUTED can still be found to have no real MT5
  // position behind it by ongoing reconciliation (see reconcileOpenTradeOutcomes).
  EXECUTED: ['RECONCILIATION_FAILED'],
  EXPIRED: [],
  CANCELLED: [],
  BLOCKED: [],
  RECONCILIATION_FAILED: [],
};

export function canTransition(from: EntryStatus, to: EntryStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export type EntryPlanInput = {
  decisionId?: string;
  symbol: string;
  side: 'BUY' | 'SELL' | 'NONE';
  entryStrategy: EntryStrategy;
  currentBid?: string | null;
  currentAsk?: string | null;
  currentPrice?: string | null;
  entryZoneLow?: string | null;
  entryZoneHigh?: string | null;
  triggerPrice?: string | null;
  referenceEntry?: string | null;
  stopLoss?: string | null;
  takeProfit?: string | null;
  riskReward?: string | null;
  recommendedVolume?: string | null;
  maxPlannedLoss?: string | null;
  targetProfit?: string | null;
  modelVersion?: string | null;
  confidence: number;
  opportunityScore: number;
  entryReason?: string | null;
  signalCandleTimestamp: string;
  validUntil: string;
  marketStatus?: string;
  dataStatus?: string;
};

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isoValidUntil(signalCandleTimestamp: string, cfg: Record<string, unknown>, fallback?: string | null): string {
  const hours = Number(cfg.mt5_entry_plan_valid_hours ?? 2);
  const signalTime = new Date(signalCandleTimestamp);
  if (Number.isFinite(signalTime.getTime()) && Number.isFinite(hours) && hours > 0) {
    return new Date(signalTime.getTime() + hours * 60 * 60 * 1000).toISOString();
  }
  return fallback && Number.isFinite(new Date(fallback).getTime()) ? new Date(fallback).toISOString() : new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
}

/** BUY must consider the executable ask price; SELL must consider the executable bid price. */
export function currentPriceForSide(input: { side: string; currentBid?: string | null; currentAsk?: string | null; currentPrice?: string | null }) {
  if (input.side === 'BUY') return numberOrNull(input.currentAsk ?? input.currentPrice);
  if (input.side === 'SELL') return numberOrNull(input.currentBid ?? input.currentPrice);
  return numberOrNull(input.currentPrice);
}

function computeRawEntryStatus(input: EntryPlanInput, now = new Date()): EntryStatus {
  if (input.entryStrategy === 'NO_ENTRY' || input.side === 'NONE') return 'BLOCKED';
  if (new Date(input.validUntil).getTime() <= now.getTime()) return 'EXPIRED';
  if (input.marketStatus && input.marketStatus !== 'OPEN') return 'BLOCKED';
  if (input.dataStatus && input.dataStatus !== 'LIVE') return 'BLOCKED';
  const current = currentPriceForSide(input);
  if (current === null) return 'BLOCKED';
  if (input.entryStrategy === 'MARKET_NOW') return 'READY';
  if (input.entryStrategy === 'PULLBACK') {
    const low = numberOrNull(input.entryZoneLow);
    const high = numberOrNull(input.entryZoneHigh);
    if (low === null || high === null) return 'BLOCKED';
    return current >= Math.min(low, high) && current <= Math.max(low, high) ? 'TRIGGERED' : 'WAITING';
  }
  const trigger = numberOrNull(input.triggerPrice);
  if (trigger === null) return 'BLOCKED';
  if (input.side === 'BUY') return current >= trigger ? 'TRIGGERED' : 'WAITING';
  return current <= trigger ? 'TRIGGERED' : 'WAITING';
}

/**
 * Computes the entry status for a fresh plan build. Unlike refreshPlanStatus,
 * this has no prior persisted status to stay "sticky" against, so it is only
 * used when a plan is first created/rebuilt from a new AI decision.
 */
export function computeEntryStatus(input: EntryPlanInput, now = new Date()): EntryStatus {
  return computeRawEntryStatus(input, now);
}

/**
 * Refreshes an already-persisted plan's status against a live tick. Once a
 * plan has reached TRIGGERED it stays TRIGGERED even if price oscillates back
 * out of the zone/trigger — the plan already committed to a claim+execute
 * attempt (or a BLOCKED/EXPIRED outcome), so flipping it back to WAITING
 * would let the same setup "re-trigger" every time price crosses the
 * boundary. Safety re-checks (market closed, stale data, expiry) still apply.
 */
export function refreshPlanStatus(priorStatus: EntryStatus, input: EntryPlanInput, now = new Date()): EntryStatus {
  const computed = computeRawEntryStatus(input, now);
  if (priorStatus === 'TRIGGERED' && (computed === 'WAITING' || computed === 'READY')) return 'TRIGGERED';
  return computed;
}

export function buildEntryPlan(decision: Mt5DecisionDTO, risk: { recommendedVolume?: string; riskAmount?: string }, cfg: Record<string, unknown>): EntryPlanInput {
  const side = decision.decision === 'BUY' || decision.decision === 'SELL' ? decision.decision : 'NONE';
  const strategy = decision.entry_strategy ?? (side === 'NONE' ? 'NO_ENTRY' : 'MARKET_NOW');
  const validUntil = isoValidUntil(decision.signal_candle_timestamp, cfg, decision.valid_until);
  const rr = numberOrNull(decision.risk_reward);
  const riskAmount = numberOrNull(risk.riskAmount);
  const plan: EntryPlanInput = {
    symbol: decision.symbol,
    side,
    entryStrategy: strategy,
    currentBid: decision.bid ?? null,
    currentAsk: decision.ask ?? null,
    currentPrice: decision.current_price ?? (side === 'BUY' ? decision.ask : decision.bid) ?? decision.reference_entry,
    entryZoneLow: decision.entry_zone_low ?? null,
    entryZoneHigh: decision.entry_zone_high ?? null,
    triggerPrice: decision.trigger_price ?? null,
    referenceEntry: decision.reference_entry,
    stopLoss: decision.stop_loss,
    takeProfit: decision.take_profit,
    riskReward: decision.risk_reward,
    recommendedVolume: risk.recommendedVolume ?? null,
    maxPlannedLoss: risk.riskAmount ?? null,
    targetProfit: riskAmount !== null && rr !== null ? (riskAmount * rr).toFixed(8) : null,
    modelVersion: decision.model_version ?? null,
    confidence: decision.confidence,
    opportunityScore: decision.opportunity_score,
    entryReason: decision.entry_reason ?? null,
    signalCandleTimestamp: decision.signal_candle_timestamp,
    validUntil,
    marketStatus: decision.market_status,
    dataStatus: decision.data_status,
  };
  return plan;
}

export function entryStatusMessage(status: string, blockReason?: string | null): string {
  const messages: Record<string, string> = {
    WAITING: 'Waiting for price to reach the AI entry zone.',
    READY: 'AI considers the current price acceptable to enter now.',
    TRIGGERED: 'Entry condition reached. Safety checks are running.',
    EXECUTING: 'Sending DEMO order to MT5.',
    EXECUTED: 'DEMO trade opened successfully.',
    EXPIRED: 'The entry price was not reached before the plan expired.',
    CANCELLED: 'This entry plan was cancelled.',
    BLOCKED: 'Entry condition was reached but the trade was blocked.',
    RECONCILIATION_FAILED: 'MT5 never confirmed this trade; it was not actually opened.',
  };
  const base = messages[status] ?? status;
  if (status === 'BLOCKED' && blockReason) return `${base} Reason: ${blockReason}.`;
  return base;
}

export function planDto(plan: EntryPlanInput, status?: EntryStatus) {
  const currentStatus = status ?? computeEntryStatus(plan);
  return {
    side: plan.side,
    entry_strategy: plan.entryStrategy,
    current_bid: plan.currentBid ?? null,
    current_ask: plan.currentAsk ?? null,
    current_price: plan.currentPrice ?? null,
    entry_zone_low: plan.entryZoneLow ?? null,
    entry_zone_high: plan.entryZoneHigh ?? null,
    trigger_price: plan.triggerPrice ?? null,
    reference_entry: plan.referenceEntry ?? null,
    stop_loss: plan.stopLoss ?? null,
    take_profit: plan.takeProfit ?? null,
    risk_reward: plan.riskReward ?? null,
    recommended_volume: plan.recommendedVolume ?? null,
    max_planned_loss: plan.maxPlannedLoss ?? null,
    target_profit: plan.targetProfit ?? null,
    model_version: plan.modelVersion ?? null,
    confidence: plan.confidence,
    opportunity_score: plan.opportunityScore,
    entry_reason: plan.entryReason ?? null,
    signal_candle_timestamp: plan.signalCandleTimestamp,
    valid_until: plan.validUntil,
    current_entry_status: currentStatus,
    status_message: entryStatusMessage(currentStatus),
  };
}

export async function persistEntryPlan(pool: Pool, decisionId: string, plan: EntryPlanInput, status: EntryStatus = computeEntryStatus(plan)) {
  const result = await pool.query(
    `INSERT INTO mt5_entry_plans(ai_decision_id, symbol, side, entry_strategy, status,
        current_bid, current_ask, current_price, entry_zone_low, entry_zone_high,
        trigger_price, reference_entry, stop_loss, take_profit, risk_reward,
        recommended_volume, max_planned_loss, target_profit, model_version,
        confidence, opportunity_score,
        entry_reason, signal_candle_timestamp, valid_until,
        triggered_at, expired_at, reached_trigger, time_to_trigger_seconds)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
        CASE WHEN $5 = 'TRIGGERED' THEN now() ELSE NULL END,
        CASE WHEN $5 = 'EXPIRED' THEN now() ELSE NULL END,
        CASE WHEN $5 = 'TRIGGERED' THEN true ELSE false END,
        CASE WHEN $5 = 'TRIGGERED' THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - $23::timestamptz)))::int ELSE NULL END)
     ON CONFLICT(ai_decision_id) DO UPDATE SET
        -- Never let a refresh clobber a plan that has already moved past the
        -- point this caller knows about (e.g. the watcher already claimed it
        -- for execution between this row being read and this write landing).
        status=CASE
          WHEN mt5_entry_plans.status IN ('EXECUTING','EXECUTED','EXPIRED','CANCELLED') THEN mt5_entry_plans.status
          ELSE EXCLUDED.status
        END,
        -- Root cause of "ALREADY_PROCESSING" on a plan the UI shows as
        -- READY: claimPlanForExecution() only claims when execution_key IS
        -- NULL, but a BLOCKED attempt (blockPlan()) sets execution_key once
        -- and this UPSERT never cleared it back out — so once a plan had
        -- been claimed even a single time (e.g. blocked by COOLDOWN), it
        -- could never be claimed again even after re-analysis correctly
        -- brought its status back to READY/TRIGGERED. The lock, block
        -- timestamp, and block reason are all stale metadata from that
        -- earlier attempt the instant the plan becomes re-eligible again,
        -- and must be cleared together with it — but only when this refresh
        -- isn't itself being discarded by the guard above (an EXECUTING/
        -- EXECUTED/EXPIRED/CANCELLED plan's lock must never be touched).
        execution_key=CASE
          WHEN mt5_entry_plans.status IN ('EXECUTING','EXECUTED','EXPIRED','CANCELLED') THEN mt5_entry_plans.execution_key
          WHEN EXCLUDED.status IN ('WAITING','READY','TRIGGERED') THEN NULL
          ELSE mt5_entry_plans.execution_key
        END,
        executing_at=CASE
          WHEN mt5_entry_plans.status IN ('EXECUTING','EXECUTED','EXPIRED','CANCELLED') THEN mt5_entry_plans.executing_at
          WHEN EXCLUDED.status IN ('WAITING','READY','TRIGGERED') THEN NULL
          ELSE mt5_entry_plans.executing_at
        END,
        blocked_at=CASE
          WHEN mt5_entry_plans.status IN ('EXECUTING','EXECUTED','EXPIRED','CANCELLED') THEN mt5_entry_plans.blocked_at
          WHEN EXCLUDED.status IN ('WAITING','READY','TRIGGERED') THEN NULL
          ELSE mt5_entry_plans.blocked_at
        END,
        block_reason=CASE
          WHEN mt5_entry_plans.status IN ('EXECUTING','EXECUTED','EXPIRED','CANCELLED') THEN mt5_entry_plans.block_reason
          WHEN EXCLUDED.status IN ('WAITING','READY','TRIGGERED') THEN NULL
          ELSE mt5_entry_plans.block_reason
        END,
        current_bid=EXCLUDED.current_bid,
        current_ask=EXCLUDED.current_ask,
        current_price=EXCLUDED.current_price,
        entry_zone_low=EXCLUDED.entry_zone_low,
        entry_zone_high=EXCLUDED.entry_zone_high,
        trigger_price=EXCLUDED.trigger_price,
        reference_entry=EXCLUDED.reference_entry,
        stop_loss=EXCLUDED.stop_loss,
        take_profit=EXCLUDED.take_profit,
        risk_reward=EXCLUDED.risk_reward,
        recommended_volume=EXCLUDED.recommended_volume,
        max_planned_loss=EXCLUDED.max_planned_loss,
        target_profit=EXCLUDED.target_profit,
        model_version=EXCLUDED.model_version,
        confidence=EXCLUDED.confidence,
        opportunity_score=EXCLUDED.opportunity_score,
        entry_reason=EXCLUDED.entry_reason,
        valid_until=EXCLUDED.valid_until,
        triggered_at=COALESCE(mt5_entry_plans.triggered_at, EXCLUDED.triggered_at),
        expired_at=COALESCE(mt5_entry_plans.expired_at, EXCLUDED.expired_at),
        reached_trigger=mt5_entry_plans.reached_trigger OR EXCLUDED.reached_trigger,
        time_to_trigger_seconds=COALESCE(mt5_entry_plans.time_to_trigger_seconds, EXCLUDED.time_to_trigger_seconds),
        updated_at=now()
     RETURNING *`,
    [
      decisionId,
      plan.symbol,
      plan.side,
      plan.entryStrategy,
      status,
      plan.currentBid ?? null,
      plan.currentAsk ?? null,
      plan.currentPrice ?? null,
      plan.entryZoneLow ?? null,
      plan.entryZoneHigh ?? null,
      plan.triggerPrice ?? null,
      plan.referenceEntry ?? null,
      plan.stopLoss ?? null,
      plan.takeProfit ?? null,
      plan.riskReward ?? null,
      plan.recommendedVolume ?? null,
      plan.maxPlannedLoss ?? null,
      plan.targetProfit ?? null,
      plan.modelVersion ?? null,
      plan.confidence,
      plan.opportunityScore,
      plan.entryReason ?? null,
      plan.signalCandleTimestamp,
      plan.validUntil,
    ],
  );
  return result.rows[0];
}

function dbPlanToInput(row: Record<string, unknown>, tick: Record<string, unknown>, market: Record<string, unknown>): EntryPlanInput {
  const side = String(row.side) === 'BUY' || String(row.side) === 'SELL' ? (String(row.side) as 'BUY' | 'SELL') : 'NONE';
  return {
    decisionId: String(row.ai_decision_id),
    symbol: String(row.symbol),
    side,
    entryStrategy: String(row.entry_strategy) as EntryStrategy,
    currentBid: tick.bid !== undefined ? String(tick.bid) : row.current_bid ? String(row.current_bid) : null,
    currentAsk: tick.ask !== undefined ? String(tick.ask) : row.current_ask ? String(row.current_ask) : null,
    currentPrice: row.current_price ? String(row.current_price) : null,
    entryZoneLow: row.entry_zone_low ? String(row.entry_zone_low) : null,
    entryZoneHigh: row.entry_zone_high ? String(row.entry_zone_high) : null,
    triggerPrice: row.trigger_price ? String(row.trigger_price) : null,
    referenceEntry: row.reference_entry ? String(row.reference_entry) : null,
    stopLoss: row.stop_loss ? String(row.stop_loss) : null,
    takeProfit: row.take_profit ? String(row.take_profit) : null,
    riskReward: row.risk_reward ? String(row.risk_reward) : null,
    recommendedVolume: row.recommended_volume ? String(row.recommended_volume) : null,
    maxPlannedLoss: row.max_planned_loss ? String(row.max_planned_loss) : null,
    targetProfit: row.target_profit ? String(row.target_profit) : null,
    modelVersion: row.model_version ? String(row.model_version) : null,
    confidence: Number(row.confidence ?? 0),
    opportunityScore: Number(row.opportunity_score ?? 0),
    entryReason: row.entry_reason ? String(row.entry_reason) : null,
    signalCandleTimestamp: new Date(String(row.signal_candle_timestamp)).toISOString(),
    validUntil: new Date(String(row.valid_until)).toISOString(),
    marketStatus: String(market.market_status ?? 'UNKNOWN'),
    dataStatus: String(market.data_status ?? 'DISCONNECTED'),
  };
}

async function refreshStoredEntryPlan(pool: Pool, row: Record<string, unknown>, actor: Mt5Actor) {
  const [tick, market] = await Promise.all([
    getMt5Tick(String(row.symbol), actor.requestId ?? undefined).catch(() => ({})),
    getMt5MarketStatus(String(row.symbol), actor.requestId ?? undefined).catch(() => ({})),
  ]);
  const plan = dbPlanToInput(row, tick, market);
  const current = currentPriceForSide(plan);
  const updated = current === null ? plan : { ...plan, currentPrice: String(current) };
  const status = refreshPlanStatus(String(row.status) as EntryStatus, updated);
  const saved = await persistEntryPlan(pool, String(row.ai_decision_id), updated, status);
  return { plan: saved, status: String(saved.status) as EntryStatus };
}

export async function listActiveEntryPlans(pool: Pool, actor: Mt5Actor) {
  const result = await pool.query(
    `SELECT * FROM mt5_entry_plans
     WHERE status IN ('WAITING','READY','TRIGGERED','EXECUTING','BLOCKED')
       AND valid_until >= now() - interval '1 hour'
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  const plans = [];
  for (const row of result.rows) {
    if (row.status === 'EXECUTING') {
      plans.push(row);
      continue;
    }
    plans.push((await refreshStoredEntryPlan(pool, row, actor)).plan);
  }
  return { plans };
}

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

interface ExecutionOutcome {
  executed: boolean;
  // `allowed` mirrors `executed` for the terminal happy-path outcome, but
  // exists as its own field so callers/UI never have to infer a block from
  // the absence of a flag: every outcome — success, block, or expiry —
  // explicitly says whether the trade was allowed.
  allowed: boolean;
  // Machine-readable rejection code (e.g. SPREAD_TOO_HIGH, DEMO_VERIFICATION_FAILED,
  // MARKET_CLOSED). Null only when allowed=true.
  code: string | null;
  entryPlan: Record<string, unknown> | null;
  reason?: string;
  risk?: Record<string, unknown>;
  check?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const RETCODE_REASON: Record<number, string> = {
  10004: 'REQUOTE',
  10006: 'ORDER_REJECTED',
  10013: 'INVALID_REQUEST',
  10014: 'INVALID_VOLUME',
  10015: 'INVALID_PRICE',
  10016: 'INVALID_STOPS',
  10017: 'TRADE_DISABLED',
  10018: 'MARKET_CLOSED',
  10019: 'MARGIN_INSUFFICIENT',
  10020: 'PRICE_CHANGED',
  10021: 'NO_QUOTES',
  10024: 'TOO_MANY_REQUESTS',
  10027: 'AUTOTRADING_DISABLED',
  10030: 'INVALID_FILLING_MODE',
  10031: 'NO_CONNECTION',
};

// This broker's terminal hard-rejects any order comment over ~28 characters
// with order_check/order_send returning None and last_error() (-2, 'Invalid
// "comment" argument') — confirmed empirically against the live connected
// DEMO terminal. `MT5_PLAN_<uuid>` (45 chars) exceeded this on every single
// execution attempt, which was the actual root cause of every "Trade in
// Demo" rejection. Comments must stay short; reconciliation only needs
// enough of the plan id back to disambiguate concurrently open positions,
// not the full UUID.
function planCommentRef(planId: unknown): string {
  return String(planId).replace(/-/g, '').slice(0, 16);
}

function retcodeReason(code: number): string {
  return RETCODE_REASON[code] ?? `MT5_RETCODE_${code}`;
}

/**
 * Atomically claims a WAITING/READY/TRIGGERED plan for execution. The
 * conditional UPDATE (single-row, single-statement) is what makes this safe
 * under concurrent watcher ticks, a manual "Trade in Demo" click racing the
 * watcher, or an API/worker restart: only one caller's UPDATE can match the
 * WHERE clause before the row's status/execution_key change, so every other
 * caller gets 0 rows back and backs off instead of double-executing.
 */
async function claimPlanForExecution(pool: Pool, planId: string): Promise<Record<string, unknown> | null> {
  const key = `entry-plan:${planId}:${Date.now()}`;
  const result = await pool.query(
    `UPDATE mt5_entry_plans
     SET status='EXECUTING', executing_at=now(), execution_key=$2, updated_at=now()
     WHERE id=$1 AND status IN ('TRIGGERED','READY') AND execution_key IS NULL
     RETURNING *`,
    [planId, key],
  );
  return result.rows[0] ?? null;
}

async function blockPlan(pool: Pool, plan: Record<string, unknown>, reason: string, message?: string): Promise<ExecutionOutcome> {
  await pool.query(
    `UPDATE mt5_entry_plans SET status='BLOCKED', blocked_at=now(), block_reason=$2, updated_at=now()
     WHERE id=$1 AND status NOT IN ('EXECUTED','EXPIRED','CANCELLED')`,
    [plan.id, reason],
  );
  return { executed: false, allowed: false, code: reason, entryPlan: { ...plan, status: 'BLOCKED', block_reason: reason }, reason: message ?? reason };
}

async function expirePlanRow(pool: Pool, plan: Record<string, unknown>): Promise<ExecutionOutcome> {
  await pool.query(
    `UPDATE mt5_entry_plans SET status='EXPIRED', expired_at=now(), updated_at=now()
     WHERE id=$1 AND status NOT IN ('EXECUTED','EXPIRED','CANCELLED')`,
    [plan.id],
  );
  return { executed: false, allowed: false, code: 'PLAN_EXPIRED', entryPlan: { ...plan, status: 'EXPIRED' }, reason: 'The entry plan expired before it could be executed' };
}

function instrumentBounds(info: Record<string, unknown> | null) {
  const min = numberOrNull(info?.volume_min) ?? 0.01;
  const max = numberOrNull(info?.volume_max) ?? 100;
  const step = numberOrNull(info?.volume_step) ?? 0.01;
  return { min: new Decimal(min), max: new Decimal(max), step: new Decimal(step) };
}

function computeSpreadPoints(tick: Record<string, unknown> | null, info: Record<string, unknown> | null): number | undefined {
  const bid = numberOrNull(tick?.bid);
  const ask = numberOrNull(tick?.ask);
  const point = numberOrNull(info?.point);
  if (bid === null || ask === null || !point) return undefined;
  return Math.round((ask - bid) / point);
}

function validateStopsAndTargets(
  side: 'BUY' | 'SELL',
  actualEntry: number,
  sl: number,
  tp: number,
  info: Record<string, unknown> | null,
): { ok: true } | { ok: false; reason: 'INVALID_SL' | 'INVALID_TP'; message: string } {
  if (!Number.isFinite(sl)) return { ok: false, reason: 'INVALID_SL', message: 'Stop Loss is missing or not a number' };
  if (!Number.isFinite(tp)) return { ok: false, reason: 'INVALID_TP', message: 'Take Profit is missing or not a number' };
  const point = numberOrNull(info?.point) ?? numberOrNull(info?.trade_tick_size) ?? 0;
  const stopsLevelPoints = Number(info?.trade_stops_level ?? 0);
  const freezeLevelPoints = Number(info?.trade_freeze_level ?? 0);
  const minDistance = point > 0 ? Math.max(stopsLevelPoints, freezeLevelPoints) * point : 0;
  if (side === 'BUY') {
    if (!(sl < actualEntry)) return { ok: false, reason: 'INVALID_SL', message: 'Stop Loss must be below the actual entry price for BUY' };
    if (!(tp > actualEntry)) return { ok: false, reason: 'INVALID_TP', message: 'Take Profit must be above the actual entry price for BUY' };
    if (minDistance > 0 && actualEntry - sl < minDistance) return { ok: false, reason: 'INVALID_SL', message: 'Stop Loss is inside the broker minimum stops/freeze level' };
    if (minDistance > 0 && tp - actualEntry < minDistance) return { ok: false, reason: 'INVALID_TP', message: 'Take Profit is inside the broker minimum stops/freeze level' };
  } else {
    if (!(sl > actualEntry)) return { ok: false, reason: 'INVALID_SL', message: 'Stop Loss must be above the actual entry price for SELL' };
    if (!(tp < actualEntry)) return { ok: false, reason: 'INVALID_TP', message: 'Take Profit must be below the actual entry price for SELL' };
    if (minDistance > 0 && sl - actualEntry < minDistance) return { ok: false, reason: 'INVALID_SL', message: 'Stop Loss is inside the broker minimum stops/freeze level' };
    if (minDistance > 0 && actualEntry - tp < minDistance) return { ok: false, reason: 'INVALID_TP', message: 'Take Profit is inside the broker minimum stops/freeze level' };
  }
  return { ok: true };
}

// Authoritative trading-day timezone: Asia/Bangkok (Thailand time), matching
// every other Thailand-time boundary already shown throughout this app
// (THAILAND_TIME_ZONE in mt5-demo-lab-service.ts). Deliberately NOT the
// database server's own `now()`/`date_trunc` timezone (which may be UTC or
// server-local and would roll the "day" over at the wrong wall-clock hour
// for a Thailand-based owner) and NOT the broker's own server clock either
// (empirically confirmed elsewhere in this codebase to run hours ahead of
// real UTC on this broker - an unreliable, non-fixed offset unsuitable as an
// authoritative boundary).
//
// Only counts a row that is a REAL MT5-confirmed entry:
//   - order_ticket is a genuine numeric MT5 ticket (never the historical
//     "entry-plan:<uuid>:<ms>" idempotency-key fallback a pre-fix bug once
//     wrote in its place - the same numeric check migration 0029 uses to
//     repair old bad rows).
//   - exit_reason is not RECONCILIATION_FAILED (a trade the app can no
//     longer verify against MT5 must never count toward "today's trades",
//     confirmed or not).
// This is a query-side fix: no data migration is needed, since it excludes
// bad historical rows automatically rather than requiring them to be
// mutated.
export async function countTradesToday(pool: Pool): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS c
       FROM trade_outcomes
      WHERE order_ticket ~ '^[0-9]+$'
        AND (exit_reason IS NULL OR exit_reason <> 'RECONCILIATION_FAILED')
        AND opened_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')
        AND opened_at <  (date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok' + interval '1 day')`,
  );
  return Number(result.rows[0]?.c ?? 0);
}

/**
 * Executes a plan that has already been atomically claimed (status is
 * EXECUTING and belongs to this call). This is the mandatory "re-check
 * everything" step: it reloads MT5 connection/account/terminal state, the
 * latest tick and market session, live positions and pending orders, then
 * re-runs the full Risk Engine, recomputes position size against the actual
 * instrument's volume bounds, and validates SL/TP against the actual entry
 * and broker stops/freeze level, before ever calling order_check/order_send.
 */
export async function executeClaimedPlan(pool: Pool, claimedPlan: Record<string, unknown>, actor: Mt5Actor): Promise<ExecutionOutcome> {
  const plan = claimedPlan;
  try {
    const cfg = loadMt5RiskSettings() as unknown as Record<string, unknown>;

    if (new Date(String(plan.valid_until)).getTime() <= Date.now()) {
      return await expirePlanRow(pool, plan);
    }
    if (cfg.mt5_kill_switch_enabled === true) {
      return await blockPlan(pool, plan, 'KILL_SWITCH', 'The demo safety switch (kill switch) is ON');
    }

    const status = await getMt5Status(actor.requestId ?? undefined).catch(() => null);
    if (!status || !status.demo_verified) {
      return await blockPlan(pool, plan, 'DEMO_VERIFICATION_FAILED', status?.blocked_reason ?? 'MT5 DEMO verification failed');
    }

    const symbol = String(plan.symbol);
    const side = String(plan.side) as 'BUY' | 'SELL';
    const [tick, market, symbolInfo, positions, pendingOrders] = await Promise.all([
      getMt5Tick(symbol, actor.requestId ?? undefined).catch(() => null),
      getMt5MarketStatus(symbol, actor.requestId ?? undefined).catch(() => null),
      getMt5SymbolInfo(symbol, actor.requestId ?? undefined).catch(() => null),
      listMt5Positions(actor.requestId ?? undefined).catch(() => []),
      listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    ]);
    if (!tick || !market) return await blockPlan(pool, plan, 'STALE_DATA', 'Could not read a fresh MT5 quote or market status');
    if (market.market_status !== 'OPEN') return await blockPlan(pool, plan, 'MARKET_CLOSED', `Broker market status is ${String(market.market_status)}`);
    if (market.data_status !== 'LIVE') return await blockPlan(pool, plan, 'STALE_DATA', `Broker data status is ${String(market.data_status)}`);

    const actualEntry = side === 'BUY' ? numberOrNull(tick.ask) : numberOrNull(tick.bid);
    if (actualEntry === null || actualEntry <= 0) return await blockPlan(pool, plan, 'STALE_DATA', 'Invalid executable bid/ask price');

    if (positions.some((position) => String(position.symbol) === symbol)) {
      return await blockPlan(pool, plan, 'POSITION_EXISTS', `An open position already exists for ${symbol}`);
    }
    if (pendingOrders.some((order) => String(order.symbol) === symbol)) {
      return await blockPlan(pool, plan, 'PENDING_ORDER', `A pending order already exists for ${symbol}`);
    }

    const cooldownMinutes = Number(cfg.mt5_cooldown_minutes ?? 60);
    if (cooldownMinutes > 0) {
      const lastTrade = await pool.query('SELECT opened_at FROM trade_outcomes WHERE symbol=$1 ORDER BY opened_at DESC LIMIT 1', [symbol]);
      const lastOpenedAt = lastTrade.rows[0]?.opened_at;
      if (lastOpenedAt) {
        const minutesSince = (Date.now() - new Date(lastOpenedAt).getTime()) / 60000;
        if (minutesSince < cooldownMinutes) {
          return await blockPlan(pool, plan, 'COOLDOWN', `${symbol} is in a ${cooldownMinutes}-minute cooldown after the last demo trade`);
        }
      }
    }

    const tradesToday = await countTradesToday(pool);
    const risk = evaluateMt5Risk({
      decision: side,
      referenceEntry: String(actualEntry),
      stopLoss: plan.stop_loss ? String(plan.stop_loss) : null,
      takeProfit: plan.take_profit ? String(plan.take_profit) : null,
      riskReward: plan.risk_reward ? String(plan.risk_reward) : null,
      confidence: Number(plan.confidence ?? 0),
      account: status.account,
      terminal: status.terminal,
      settings: cfg,
      openPositions: positions.length,
      tradesToday,
      quoteAgeSeconds: typeof market.quote_age_seconds === 'number' ? market.quote_age_seconds : undefined,
      spreadPoints: computeSpreadPoints(tick, symbolInfo),
      marketStatus: market.market_status as 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN',
      dataStatus: market.data_status as 'LIVE' | 'STALE' | 'DISCONNECTED',
      symbol: toRiskSymbolInfo(symbolInfo),
      leverage: Number(status.account?.leverage) || null,
    });

    const riskRow = await pool.query(
      'INSERT INTO risk_evaluations(ai_decision_id, symbol, result, failed_rules, reason, snapshot) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [plan.ai_decision_id, symbol, risk.result, JSON.stringify(risk.failedRules), risk.reason, risk.snapshot],
    );

    const bounds = instrumentBounds(symbolInfo);
    const finalVolume = normalizeVolume(new Decimal(risk.recommendedVolume), bounds.min, bounds.max, bounds.step);

    if (risk.result !== 'PASS') {
      return await blockPlan(pool, plan, risk.failedRules[0] ?? 'RISK_LIMIT', risk.reason ?? 'Risk Engine rejected this trade');
    }
    if (finalVolume.lte(0)) {
      return await blockPlan(pool, plan, 'POSITION_SIZE_INVALID', 'Recalculated lot size is below the symbol minimum volume');
    }

    const slTp = validateStopsAndTargets(side, actualEntry, Number(plan.stop_loss), Number(plan.take_profit), symbolInfo);
    if (!slTp.ok) return await blockPlan(pool, plan, slTp.reason, slTp.message);

    await pool.query(
      `UPDATE mt5_entry_plans SET final_volume=$2, actual_entry=$3, updated_at=now() WHERE id=$1 AND status='EXECUTING'`,
      [plan.id, finalVolume.toFixed(8), actualEntry],
    );

    const executionKey = String(plan.execution_key ?? `entry-plan:${plan.id}`);
    const request: Mt5OrderRequestDTO = {
      idempotency_key: executionKey,
      symbol,
      side,
      volume: Number(finalVolume),
      stop_loss: Number(plan.stop_loss),
      take_profit: Number(plan.take_profit),
      deviation: Number(cfg.mt5_allowed_deviation_points ?? 20),
      comment: `P${planCommentRef(plan.id)}`,
    };

    let check: Record<string, unknown>;
    try {
      check = await checkMt5Order(request, actor.requestId ?? undefined);
    } catch (err) {
      // The Python DemoExecutionGateway already rejects None/bad-retcode
      // order_check results itself (see mt5/adapter.py) — this catch is a
      // second line of defense, not the primary check. This is genuinely an
      // order_check-level rejection (bad request shape/comment/volume/etc),
      // not a DEMO-verification problem — status/login/server were already
      // confirmed above before this ever runs.
      return await blockPlan(pool, plan, 'ORDER_CHECK_FAILED', (err as Error).message);
    }
    // NOTE: unlike order_send (whose only success codes are the documented
    // TRADE_RETCODE_DONE/DONE_PARTIAL), order_check() empirically returns
    // retcode=0 with comment="Done" for a request that would succeed on this
    // broker — confirmed against the live connected MT5 DEMO terminal. A
    // missing/None order_check result is already rejected as an exception by
    // the Gateway before this ever runs (see mt5/adapter.py), so a genuine 0
    // here reflects a real OrderCheckResult, not a missing one.
    const checkRetcode = Number(check.retcode ?? -1);
    if (![0, 10008, 10009].includes(checkRetcode)) {
      return await blockPlan(pool, plan, retcodeReason(checkRetcode), `order_check rejected the request: retcode ${checkRetcode}`);
    }

    let result: Record<string, unknown>;
    try {
      result = await sendMt5Order(request, actor.requestId ?? undefined);
    } catch (err) {
      // The Gateway itself already validates retcode, requires a real
      // order/deal ticket, and confirms the position via positions_get()
      // before returning success — so any exception here (rejected retcode,
      // missing ticket, or "succeeded but no position found") means MT5
      // never confirmed a real position. Do NOT guess and do NOT retry from
      // here — leave the plan in EXECUTING exactly as claimed.
      // reconcileStuckExecutions (run at the top of every watcher tick and
      // on startup) is the single place that decides this plan's fate once
      // the grace period elapses: it checks trade_outcomes and live MT5
      // positions by comment before ever releasing the plan back to
      // TRIGGERED for a fresh, fully re-checked retry, so a slow-but-
      // successful order_send can never be duplicated and a genuinely
      // rejected order can never be mistaken for an open position.
      return {
        executed: false,
        allowed: false,
        code: 'EXECUTION_UNCONFIRMED',
        entryPlan: { ...plan, status: 'EXECUTING' },
        reason: `order_send was not confirmed by MT5: ${(err as Error).message}`,
      };
    }

    // 0 is accepted alongside DONE/DONE_PARTIAL: this broker's trade server
    // empirically reports retcode=0 for a genuinely successful order_send
    // (see mt5/adapter.py for the confirmed evidence). Safety does not rest
    // on this value — the ticket presence check and confirmed_position below
    // are what actually gate whether this is ever recorded as executed; the
    // Python Gateway has already independently validated all of this and
    // would have thrown before returning here if it could not confirm a
    // real position, so this is a second line of defense, not the primary one.
    const retcode = Number(result.retcode ?? -1);
    if (![0, 10009, 10010].includes(retcode)) {
      return await blockPlan(pool, plan, retcodeReason(retcode), `MT5 order_send rejected the order: retcode ${retcode}`);
    }

    const orderTicket = result.order !== undefined && result.order !== null ? String(result.order) : null;
    const dealTicket = result.deal !== undefined && result.deal !== null ? String(result.deal) : null;
    if (!orderTicket && !dealTicket) {
      // Should be unreachable — the Gateway itself refuses to return success
      // without a real ticket — but never fabricate one from the execution
      // key if it somehow happens; that fabrication was the exact root
      // cause of trades showing OPEN in the app with no real MT5 position.
      return await blockPlan(pool, plan, 'RECONCILIATION_FAILED', 'MT5 order_send reported success but returned no order/deal ticket');
    }

    // The confirmed live position (attached by the Gateway after
    // positions_get() verification) is the most authoritative source for
    // what actually happened — prefer it over the pre-trade tick estimate.
    const confirmedPosition = (result.confirmed_position ?? null) as Record<string, unknown> | null;
    const confirmedEntry = numberOrNull(confirmedPosition?.price_open) ?? actualEntry;
    const confirmedVolume = numberOrNull(confirmedPosition?.volume);
    const persistedVolume = confirmedVolume !== null ? confirmedVolume.toFixed(8) : finalVolume.toFixed(8);
    const slippage = new Decimal(confirmedEntry).minus(new Decimal(String(plan.reference_entry ?? confirmedEntry))).toFixed(8);
    const openedAt = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO trade_outcomes(symbol, ai_decision_id, entry_plan_id, order_ticket, deal_ticket, retcode, side,
            volume, expected_entry, actual_entry, stop_loss, take_profit, risk_amount, risk_reward, slippage,
            account_equity_at_entry, opened_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
         ON CONFLICT (entry_plan_id) WHERE entry_plan_id IS NOT NULL DO NOTHING`,
        [
          symbol,
          plan.ai_decision_id,
          plan.id,
          orderTicket,
          dealTicket,
          retcode,
          side,
          persistedVolume,
          plan.reference_entry,
          confirmedEntry,
          plan.stop_loss,
          plan.take_profit,
          risk.riskAmount,
          plan.risk_reward,
          slippage,
          numberOrNull(status.account?.equity),
        ],
      );
      await client.query(
        `UPDATE mt5_entry_plans SET status='EXECUTED', executed_at=now(), actual_entry=$2, final_volume=$3,
            order_ticket=$4, deal_ticket=$5, retcode=$6, updated_at=now()
         WHERE id=$1 AND status='EXECUTING'`,
        [plan.id, confirmedEntry, persistedVolume, orderTicket, dealTicket, retcode],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await createAuditLog(pool, {
      eventType: 'MT5_ENTRY_PLAN_EXECUTED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'mt5_entry_plan',
      entityId: String(plan.id),
      action: 'ENTRY_PLAN_EXECUTE',
      afterData: { check, result },
      requestId: actor.requestId ?? null,
    });

    return {
      executed: true,
      allowed: true,
      code: null,
      entryPlan: {
        ...plan,
        status: 'EXECUTED',
        actual_entry: confirmedEntry,
        final_volume: persistedVolume,
        order_ticket: orderTicket,
        deal_ticket: dealTicket,
        opened_at: openedAt,
      },
      risk: riskRow.rows[0],
      check,
      result,
    };
  } catch (err) {
    await pool.query(
      `UPDATE mt5_entry_plans SET status='BLOCKED', blocked_at=now(), block_reason=$2, updated_at=now() WHERE id=$1 AND status='EXECUTING'`,
      [plan.id, 'UNEXPECTED_ERROR'],
    );
    throw err;
  }
}

/**
 * Reconciles plans stuck in EXECUTING past a grace period (worker crash,
 * API restart, or an order_send call that never returned). It never
 * assumes an order was NOT placed: it first checks the local trade_outcomes
 * record, then live MT5 positions by comment, and only releases the plan
 * back to TRIGGERED for a safe retry when neither shows evidence of an
 * actual MT5 order.
 */
export async function reconcileStuckExecutions(pool: Pool, actor: Mt5Actor, graceSeconds = 120): Promise<void> {
  const stuck = await pool.query(
    `SELECT * FROM mt5_entry_plans WHERE status='EXECUTING' AND executing_at <= now() - ($1 || ' seconds')::interval`,
    [graceSeconds],
  );
  if (!stuck.rows.length) return;

  const positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => []);

  for (const row of stuck.rows) {
    const outcome = await pool.query('SELECT * FROM trade_outcomes WHERE entry_plan_id = $1', [row.id]);
    if (outcome.rows[0]) {
      const o = outcome.rows[0];
      await pool.query(
        `UPDATE mt5_entry_plans SET status='EXECUTED', executed_at=COALESCE(executed_at, now()),
            actual_entry=COALESCE(actual_entry, $2), final_volume=COALESCE(final_volume, $3),
            order_ticket=COALESCE(order_ticket, $4), updated_at=now()
         WHERE id=$1 AND status='EXECUTING'`,
        [row.id, o.actual_entry, o.volume, o.order_ticket],
      );
      continue;
    }

    const matched = positions.find((position) => String(position.comment ?? '').includes(planCommentRef(row.id)));
    if (matched) {
      const actualEntry = numberOrNull(matched.price_open) ?? row.reference_entry;
      await pool.query(
        `INSERT INTO trade_outcomes(symbol, ai_decision_id, entry_plan_id, order_ticket, side, volume,
            expected_entry, actual_entry, stop_loss, take_profit, risk_amount, risk_reward, opened_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (entry_plan_id) WHERE entry_plan_id IS NOT NULL DO NOTHING`,
        [
          row.symbol,
          row.ai_decision_id,
          row.id,
          String(matched.ticket ?? ''),
          row.side,
          matched.volume ?? row.recommended_volume,
          row.reference_entry,
          actualEntry,
          row.stop_loss,
          row.take_profit,
          row.max_planned_loss,
          row.risk_reward,
        ],
      );
      await pool.query(
        `UPDATE mt5_entry_plans SET status='EXECUTED', executed_at=now(), actual_entry=$2, order_ticket=$3, updated_at=now()
         WHERE id=$1 AND status='EXECUTING'`,
        [row.id, actualEntry, String(matched.ticket ?? '')],
      );
      continue;
    }

    // No local record and no live MT5 position with this plan's comment —
    // safe to release for a fresh, fully re-checked retry.
    await pool.query(
      `UPDATE mt5_entry_plans SET status='TRIGGERED', executing_at=NULL, execution_key=NULL, updated_at=now()
       WHERE id=$1 AND status='EXECUTING'`,
      [row.id],
    );
  }
}

const NUMERIC_TICKET = /^\d+$/;

// MT5 DEAL_ENTRY_* / DEAL_REASON_* — see MetaTrader5/__init__.py.
const DEAL_ENTRY_OUT = 1;
const DEAL_REASON_EXIT_LABEL: Record<number, 'STOP_LOSS' | 'TAKE_PROFIT' | 'RISK_EXIT' | 'MANUAL_CLOSE' | 'BROKER_CLOSE' | 'OTHER'> = {
  0: 'MANUAL_CLOSE', // DEAL_REASON_CLIENT
  1: 'MANUAL_CLOSE', // DEAL_REASON_MOBILE
  2: 'MANUAL_CLOSE', // DEAL_REASON_WEB
  3: 'OTHER', // DEAL_REASON_EXPERT
  4: 'STOP_LOSS', // DEAL_REASON_SL
  5: 'TAKE_PROFIT', // DEAL_REASON_TP
  6: 'RISK_EXIT', // DEAL_REASON_SO (stop out)
  7: 'BROKER_CLOSE', // DEAL_REASON_ROLLOVER
  8: 'BROKER_CLOSE', // DEAL_REASON_VMARGIN
  9: 'BROKER_CLOSE', // DEAL_REASON_SPLIT
};

async function markTradeOutcomeReconciliationFailed(pool: Pool, row: Record<string, unknown>, reason: string): Promise<void> {
  await pool.query(
    `UPDATE trade_outcomes SET closed_at=now(), exit_reason='RECONCILIATION_FAILED' WHERE id=$1 AND closed_at IS NULL`,
    [row.id],
  );
  if (row.entry_plan_id) {
    await pool.query(
      `UPDATE mt5_entry_plans SET status='RECONCILIATION_FAILED', blocked_at=now(), block_reason=$2, updated_at=now()
       WHERE id=$1 AND status NOT IN ('EXPIRED','CANCELLED','RECONCILIATION_FAILED')`,
      [row.entry_plan_id, reason],
    );
  }
}

/** Looks up the closing deal(s) for a position ticket via MT5 deal history and closes the trade_outcomes row with the real exit reason and realized P&L. Returns false if no closing deal could be found (caller then marks the row as a reconciliation failure rather than leaving it ambiguously "open"). */
async function closeTradeOutcomeFromHistory(pool: Pool, row: Record<string, unknown>, actor: Mt5Actor): Promise<boolean> {
  const openedAt = new Date(String(row.opened_at));
  const hoursSinceOpen = Number.isFinite(openedAt.getTime()) ? Math.ceil((Date.now() - openedAt.getTime()) / 3_600_000) + 1 : 24;
  const hours = Math.min(Math.max(hoursSinceOpen, 1), 24 * 90);
  const deals = await getMt5HistoryDeals(String(row.symbol), hours, actor.requestId ?? undefined).catch(() => null);
  if (!deals) return false;

  const positionId = String(row.order_ticket);
  const closingDeals = deals.filter((deal) => String(deal.position_id ?? '') === positionId && Number(deal.entry) === DEAL_ENTRY_OUT);
  if (!closingDeals.length) return false;

  const realizedPnl = closingDeals.reduce((sum, deal) => sum + (numberOrNull(deal.profit) ?? 0), 0);
  const fees = closingDeals.reduce((sum, deal) => sum + Math.abs(numberOrNull(deal.commission) ?? 0) + Math.abs(numberOrNull(deal.swap) ?? 0), 0);
  const last = closingDeals[closingDeals.length - 1];
  const exitReason = DEAL_REASON_EXIT_LABEL[Number(last.reason ?? -1)] ?? 'OTHER';
  const closedAtSeconds = numberOrNull(last.time);
  const closedAt = closedAtSeconds !== null ? new Date(closedAtSeconds * 1000) : new Date();

  await pool.query(
    `UPDATE trade_outcomes SET closed_at=$2, exit_reason=$3, realized_pnl=$4, fees=$5 WHERE id=$1 AND closed_at IS NULL`,
    [row.id, closedAt.toISOString(), exitReason, realizedPnl.toFixed(8), fees.toFixed(8)],
  );
  return true;
}

/**
 * Open Trades/History must reflect MT5 reality, not just DB intent. This
 * verifies every trade_outcomes row still marked open (closed_at IS NULL)
 * against live positions_get(): a non-numeric order_ticket proves the
 * original order_send was never actually confirmed (the exact shape of the
 * bug that let ETHUSD show as open with no real MT5 position); a numeric
 * ticket no longer present in positions_get() means the position closed
 * (externally, by SL/TP, or by another process) and is reconciled against
 * MT5 deal history for the real exit reason and P&L.
 */
export async function reconcileOpenTradeOutcomes(pool: Pool, actor: Mt5Actor): Promise<void> {
  const openRows = await pool.query('SELECT * FROM trade_outcomes WHERE closed_at IS NULL ORDER BY opened_at ASC LIMIT 100');
  if (!openRows.rows.length) return;

  const positions = await listMt5Positions(actor.requestId ?? undefined).catch(() => null);
  if (positions === null) return; // MT5 unreachable this tick — never guess, just retry next tick.
  const openTickets = new Set(positions.map((position) => String(position.ticket ?? '')));

  for (const row of openRows.rows) {
    const orderTicket = row.order_ticket ? String(row.order_ticket) : '';
    if (!NUMERIC_TICKET.test(orderTicket)) {
      await markTradeOutcomeReconciliationFailed(pool, row, 'Order ticket is not a real MT5 ticket; order_send was never confirmed');
      continue;
    }
    if (openTickets.has(orderTicket)) continue; // MT5-confirmed: genuinely still open.

    const closed = await closeTradeOutcomeFromHistory(pool, row, actor);
    if (!closed) {
      await markTradeOutcomeReconciliationFailed(pool, row, 'Position is no longer open in MT5 and no closing deal history was found');
    }
  }
}

async function expireStalePlans(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE mt5_entry_plans SET status='EXPIRED', expired_at=now(), updated_at=now()
     WHERE status IN ('WAITING','READY','TRIGGERED') AND valid_until <= now()`,
  );
}

/**
 * Runs one watcher pass over active plans (WAITING/READY/TRIGGERED). NO_ENTRY
 * plans are never persisted with these statuses (buildEntryPlan marks them
 * BLOCKED immediately), so this query structurally never sees them.
 */
export async function runEntryPlanWatcherTick(pool: Pool, actor: Mt5Actor, autoDemoEnabled: boolean) {
  await reconcileStuckExecutions(pool, actor).catch((err) => {
    console.warn('[mt5-entry-plan-watcher] execution reconciliation failed:', (err as Error).message);
  });
  await reconcileOpenTradeOutcomes(pool, actor).catch((err) => {
    console.warn('[mt5-entry-plan-watcher] open trade reconciliation failed:', (err as Error).message);
  });
  await expireStalePlans(pool).catch(() => undefined);

  const result = await pool.query(
    `SELECT * FROM mt5_entry_plans WHERE status IN ('WAITING','READY','TRIGGERED') ORDER BY created_at ASC LIMIT 50`,
  );
  const outcomes: ExecutionOutcome[] = [];
  for (const row of result.rows) {
    if (new Date(String(row.valid_until)).getTime() <= Date.now()) {
      outcomes.push(await expirePlanRow(pool, row));
      continue;
    }
    const refreshed = await refreshStoredEntryPlan(pool, row, actor);
    if ((refreshed.status === 'TRIGGERED' || refreshed.status === 'READY') && autoDemoEnabled) {
      const claimed = await claimPlanForExecution(pool, String(refreshed.plan.id));
      if (!claimed) {
        outcomes.push({ executed: false, allowed: false, code: 'ALREADY_PROCESSING', entryPlan: refreshed.plan, reason: 'Plan is already being processed' });
        continue;
      }
      outcomes.push(await executeClaimedPlan(pool, claimed, actor));
    } else {
      outcomes.push({ executed: false, allowed: false, code: null, entryPlan: refreshed.plan });
    }
  }
  return { processed: outcomes.length, outcomes };
}

// ---------------------------------------------------------------------------
// Manual / immediate execution paths (owner "Trade in Demo" button, and the
// H1 scheduler's optional immediate MARKET_NOW execution). Both share the
// exact same claim+execute engine as the watcher so duplicate protection is
// consistent no matter what triggered the attempt.
// ---------------------------------------------------------------------------

type DemoExecutionMode = 'AUTO_DEMO' | 'ASSISTED_DEMO';

// Idempotency contract: a second/duplicate request for a plan that is
// already mid-flight or already resolved must never surface a generic
// "ALREADY_PROCESSING" — the exact reason is always knowable from the row's
// own status, so return it. EXECUTING in particular must say so plainly
// (EXECUTION_IN_PROGRESS) rather than implying the plan was simply never
// eligible, and an already-EXECUTED plan must hand back the real MT5 ticket
// so a double-click can never look like a silent failure.
export function describeUnclaimablePlan(row: Record<string, unknown> | undefined): { code: string; reason: string } {
  const status = String(row?.status ?? '');
  switch (status) {
    case 'EXECUTING':
      return { code: 'EXECUTION_IN_PROGRESS', reason: 'This entry plan is already being executed. Wait for it to finish before trying again.' };
    case 'EXECUTED': {
      const ticket = row?.order_ticket ?? row?.deal_ticket;
      return { code: 'ALREADY_EXECUTED', reason: ticket ? `This entry plan already executed in MT5 (ticket ${ticket}).` : 'This entry plan already executed in MT5.' };
    }
    case 'EXPIRED':
      return { code: 'PLAN_EXPIRED', reason: 'This entry plan expired before it could be executed.' };
    case 'CANCELLED':
      return { code: 'PLAN_CANCELLED', reason: 'This entry plan was cancelled.' };
    case 'BLOCKED':
      return { code: String(row?.block_reason ?? 'BLOCKED'), reason: 'This entry plan is currently blocked and cannot be executed.' };
    case 'WAITING':
      return { code: 'WAITING_ENTRY', reason: 'AI is still waiting for price to reach the entry condition.' };
    default:
      // Row not found, or a genuine claim race with another concurrent
      // request that landed between our SELECT and UPDATE — the row itself
      // could not tell us anything more specific than "try again".
      return { code: 'ALREADY_PROCESSING', reason: 'This entry plan could not be claimed for execution right now. Try again in a moment.' };
  }
}

export async function executeEntryPlanById(pool: Pool, planId: string, actor: Mt5Actor): Promise<ExecutionOutcome> {
  const claimed = await claimPlanForExecution(pool, planId);
  if (!claimed) {
    const current = await pool.query('SELECT * FROM mt5_entry_plans WHERE id=$1', [planId]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    const { code, reason } = describeUnclaimablePlan(row);
    return {
      executed: false,
      allowed: false,
      code,
      entryPlan: row ?? { id: planId },
      reason,
    };
  }
  return executeClaimedPlan(pool, claimed, actor);
}

async function executeDemoTradeForSymbol(
  pool: Pool,
  symbol: string,
  actor: Mt5Actor,
  mode: DemoExecutionMode,
  runAssistedAnalysis: (pool: Pool, symbol: string, actor: Mt5Actor) => Promise<{ decision: Record<string, unknown>; entryPlan: Record<string, unknown> }>,
) {
  const cfg = loadMt5RiskSettings();
  // AUTO-DEMO gating only applies to the backend's own automatic execution
  // (mode==='AUTO_DEMO', driven by the watcher/scheduler). It must never gate
  // ASSISTED_DEMO — an owner-approved "Trade in Demo" click is a manual,
  // in-the-moment authorization that AUTO-DEMO's off switch does not cover.
  if (mode === 'AUTO_DEMO' && cfg.mt5_auto_demo_enabled !== true) {
    return { executed: false, allowed: false, code: 'AUTO_DEMO_DISABLED', entryPlan: null, reason: 'AUTO-DEMO is disabled; automatic execution is not permitted.' };
  }
  const status = await getMt5Status(actor.requestId ?? undefined);
  if (!status.demo_verified) {
    return {
      executed: false,
      allowed: false,
      code: 'DEMO_VERIFICATION_FAILED',
      entryPlan: null,
      reason: status.blocked_reason ?? 'MT5 DEMO is not verified',
    };
  }

  const analysis = await runAssistedAnalysis(pool, symbol, actor);
  const entryPlanStatus = String(analysis.entryPlan.current_entry_status ?? analysis.entryPlan.status ?? 'BLOCKED');
  if (!['READY', 'TRIGGERED'].includes(entryPlanStatus)) {
    // The plan's own block_reason (set by risk/analysis evaluation) is the
    // most specific code available here — fall back to the plan status only
    // when no rule-level reason was recorded.
    const code = (analysis.entryPlan.block_reason as string | undefined) ?? entryPlanStatus;
    return {
      executed: false,
      allowed: false,
      code,
      decision: analysis.decision,
      entryPlan: analysis.entryPlan,
      reason: `Entry plan is ${entryPlanStatus}; execution is not allowed yet.`,
    };
  }

  const outcome = await executeEntryPlanById(pool, String(analysis.entryPlan.id), actor);
  await createAuditLog(pool, {
    eventType: mode === 'AUTO_DEMO' ? 'MT5_AUTO_DEMO_ORDER_SENT' : 'MT5_ASSISTED_DEMO_ORDER_SENT',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_decision',
    entityId: String(analysis.decision.id ?? ''),
    action: mode === 'AUTO_DEMO' ? 'AUTO_DEMO_EXECUTE' : 'ASSISTED_DEMO_EXECUTE',
    afterData: { check: outcome.check ?? null, result: outcome.result ?? null, reason: outcome.reason ?? null },
    requestId: actor.requestId ?? null,
  });
  return { ...outcome, decision: analysis.decision };
}

// ---------------------------------------------------------------------------
// Manual DEMO test order — a developer/diagnostic action to verify the
// execution pipe independently of the AI strategy. It is NOT gated by
// AUTO-DEMO (it is an explicit owner-triggered action, not automatic), but
// it goes through the exact same checkMt5Order/sendMt5Order calls — and
// therefore the same DemoExecutionGateway — as every other execution path.
// No second execution implementation is created here.
// ---------------------------------------------------------------------------

export interface DemoTestOrderResult {
  executed: true;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  actualEntry: number;
  stopLoss: number;
  takeProfit: number;
  orderTicket: string | null;
  dealTicket: string | null;
  retcode: number;
}

export async function sendMt5DemoTestOrder(pool: Pool, symbol: string, side: 'BUY' | 'SELL', actor: Mt5Actor): Promise<DemoTestOrderResult> {
  const cfg = loadMt5RiskSettings();
  if (cfg.mt5_kill_switch_enabled === true) {
    throw new Error('The demo safety switch (kill switch) is ON; refusing to send a test order');
  }

  const status = await getMt5Status(actor.requestId ?? undefined);
  if (!status.demo_verified) {
    throw new Error(status.blocked_reason ?? 'MT5 DEMO is not verified');
  }

  const [tick, market, symbolInfo, positions, pendingOrders] = await Promise.all([
    getMt5Tick(symbol, actor.requestId ?? undefined),
    getMt5MarketStatus(symbol, actor.requestId ?? undefined),
    getMt5SymbolInfo(symbol, actor.requestId ?? undefined),
    listMt5Positions(actor.requestId ?? undefined),
    listMt5PendingOrders(actor.requestId ?? undefined),
  ]);

  if (market.market_status !== 'OPEN') throw new Error(`Market is not open for ${symbol}: ${String(market.market_status)}`);
  if (market.data_status !== 'LIVE') throw new Error(`Market data is not live for ${symbol}: ${String(market.data_status)}`);
  if (positions.some((position) => String(position.symbol) === symbol)) {
    throw new Error(`An open position already exists for ${symbol}; refusing to stack a test order`);
  }
  if (pendingOrders.some((order) => String(order.symbol) === symbol)) {
    throw new Error(`A pending order already exists for ${symbol}`);
  }

  const actualEntry = side === 'BUY' ? numberOrNull(tick.ask) : numberOrNull(tick.bid);
  if (actualEntry === null || actualEntry <= 0) throw new Error(`Invalid executable bid/ask price for ${symbol}`);

  const bounds = instrumentBounds(symbolInfo);
  const volume = bounds.min; // smallest possible lot size — the safest test.

  const point = numberOrNull(symbolInfo?.point) ?? numberOrNull(symbolInfo?.trade_tick_size) ?? 0;
  if (point <= 0) throw new Error(`Could not read a valid point size for ${symbol}`);
  const stopsLevelPoints = Number(symbolInfo?.trade_stops_level ?? 0);
  const freezeLevelPoints = Number(symbolInfo?.trade_freeze_level ?? 0);
  // A generous safety margin above the broker minimum stops/freeze level so
  // the request is never rejected purely for being too close to price.
  const distance = Math.max(stopsLevelPoints, freezeLevelPoints, 50) * point * 3;

  const stopLoss = side === 'BUY' ? actualEntry - distance : actualEntry + distance;
  const takeProfit = side === 'BUY' ? actualEntry + distance : actualEntry - distance;

  const slTp = validateStopsAndTargets(side, actualEntry, stopLoss, takeProfit, symbolInfo);
  if (!slTp.ok) throw new Error(slTp.message);

  const request: Mt5OrderRequestDTO = {
    idempotency_key: `demo-test:${symbol}:${Date.now()}`,
    symbol,
    side,
    volume: Number(volume),
    stop_loss: Number(stopLoss.toFixed(8)),
    take_profit: Number(takeProfit.toFixed(8)),
    deviation: Number(cfg.mt5_allowed_deviation_points ?? 20),
    comment: `DEVTEST${Date.now().toString(36)}`,
  };

  const check = await checkMt5Order(request, actor.requestId ?? undefined);
  const checkRetcode = Number(check.retcode ?? -1);
  if (![0, 10008, 10009].includes(checkRetcode)) {
    throw new Error(`order_check rejected the test order: retcode ${checkRetcode} (${retcodeReason(checkRetcode)})`);
  }

  const result = await sendMt5Order(request, actor.requestId ?? undefined);
  const retcode = Number(result.retcode ?? -1);
  if (![0, 10009, 10010].includes(retcode)) {
    throw new Error(`order_send rejected the test order: retcode ${retcode} (${retcodeReason(retcode)})`);
  }

  const orderTicket = result.order !== undefined && result.order !== null ? String(result.order) : null;
  const dealTicket = result.deal !== undefined && result.deal !== null ? String(result.deal) : null;
  if (!orderTicket && !dealTicket) {
    throw new Error('MT5 order_send did not return an order/deal ticket; refusing to record a test trade');
  }

  const confirmedPosition = (result.confirmed_position ?? null) as Record<string, unknown> | null;
  const confirmedEntry = numberOrNull(confirmedPosition?.price_open) ?? actualEntry;
  const confirmedVolume = numberOrNull(confirmedPosition?.volume) ?? Number(volume);

  await pool.query(
    `INSERT INTO trade_outcomes(symbol, order_ticket, deal_ticket, retcode, side, volume, expected_entry,
        actual_entry, stop_loss, take_profit, account_equity_at_entry, opened_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
    [
      symbol, orderTicket, dealTicket, retcode, side, confirmedVolume.toFixed(8), actualEntry, confirmedEntry,
      stopLoss.toFixed(8), takeProfit.toFixed(8), numberOrNull(status.account?.equity),
    ],
  );

  await createAuditLog(pool, {
    eventType: 'MT5_DEMO_TEST_ORDER_SENT',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'mt5_test_order',
    entityId: null,
    action: 'DEMO_TEST_ORDER',
    afterData: { request, check, result },
    requestId: actor.requestId ?? null,
  });

  return {
    executed: true,
    symbol,
    side,
    volume: confirmedVolume,
    actualEntry: confirmedEntry,
    stopLoss,
    takeProfit,
    orderTicket,
    dealTicket,
    retcode,
  };
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Mt5Actor = {
  actorId: null,
  actorEmail: 'mt5-entry-plan-watcher@internal',
  requestId: 'mt5-entry-plan-watcher',
};

let lastTickAt: string | null = null;
let lastTickProcessed = 0;
let lastTickError: string | null = null;
let watcherStarted = false;
let watcherIntervalMs = 15_000;

export function getEntryPlanWatcherStatus() {
  return {
    started: watcherStarted,
    intervalMs: watcherIntervalMs,
    autoDemoEnabled: loadMt5RiskSettings().mt5_auto_demo_enabled === true,
    lastTickAt,
    lastTickProcessed,
    lastTickError,
  };
}

export function startMt5EntryPlanWatcher(pool: Pool) {
  watcherIntervalMs = Number(process.env.MT5_ENTRY_WATCHER_INTERVAL_MS ?? 15_000);
  const tick = async () => {
    try {
      const enabled = loadMt5RiskSettings().mt5_auto_demo_enabled;
      const { processed } = await runEntryPlanWatcherTick(pool, SYSTEM_ACTOR, enabled);
      lastTickAt = new Date().toISOString();
      lastTickProcessed = processed;
      lastTickError = null;
    } catch (err) {
      lastTickError = (err as Error).message;
      console.error('[mt5-entry-plan-watcher] tick failed:', err);
    }
  };
  watcherStarted = true;
  // Run once shortly after startup so a restart recovers WAITING plans and
  // reconciles any EXECUTING plans left behind by a crash, without waiting
  // a full interval.
  setTimeout(tick, 2_000);
  setInterval(tick, watcherIntervalMs);
}

export { executeDemoTradeForSymbol };
