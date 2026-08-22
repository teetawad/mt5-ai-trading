import crypto from 'crypto';
import { Pool } from 'pg';
import { getMt5MarketStatus, getMt5Status, getMt5SymbolInfo, listMt5PendingOrders, listMt5Positions } from '../mt5-client';
import { effectiveMt5RiskSettings, loadMt5RiskSettings } from '../../config/mt5-risk-settings';
import { loadAiScannerSettings } from '../../config/ai-scanner-settings';
import { countTradesToday, Mt5Actor } from '../mt5-entry-plan-watcher';
import { evaluateMt5Risk, toRiskSymbolInfo } from '../mt5-risk-engine';
import { analyzeSymbolWithAI, AiTradePlanDetail, BrokerPreflightInput, PROMPT_VERSION, runBrokerPreflight } from './trading-ai-service';
import { buildMarketAnalysisPackage } from './market-analysis';
import { computeShortlistScore } from './shortlist-score';
import { deriveTradeability } from './tradeability';
import { deriveProfitability } from './profitability';
import { TRADE_RATING_LABEL_TH, TradeRating, tradeRatingFor } from './trade-score';
import { describeTradingAIProvider } from './provider';
import { MarketAnalysisPackage } from './types';
import { createShadowTradesForCycle } from './shadow-trade-service';
import { AI_PROVIDER_ERROR_CODE_SET, classifyAiFailure, TechnicalBlockCode, technicalStatusForAction } from './ai-failure-classification';

// "FIND BEST TRADES" is a two-stage scanner (spec sections 2-5, 14):
//
//   STAGE A (this file, cheap/free): a deterministic MT5-only pre-filter
//   over every real, catalog-synced instrument, followed by a lightweight
//   technical shortlist score — no OpenAI call anywhere in this stage.
//
//   STAGE B (analyzeSymbolWithAI, paid): the existing, unmodified Trading AI
//   pipeline, run ONLY on the top-N shortlisted symbols (AiScannerSettings'
//   ai_best_trades_shortlist_size) — one hard cost ceiling on this feature.
//   A second ceiling (spec section 18) is the recent-analysis reuse cache
//   below: a shortlisted symbol whose most recent successful analysis is on
//   the SAME completed H1 candle and still within the configured freshness
//   window is reused instead of spending a fresh OpenAI call.
//
// Never send a pseudo-symbol ("SCAN", "ALL", "BEST", "*") into either
// stage — every candidate here comes from the `instruments` table, which is
// itself only ever populated from a real MT5 symbols_get() sync
// (mt5-demo-lab-service.ts's syncMt5Instruments), never invented. The
// historical "SCAN is not a real MT5 instrument" bug was never actually
// caused by this file: it was an Express route-ordering bug in mt5.ts where
// POST /ai-trade/:symbol (registered before POST /ai-trade/scan) silently
// swallowed every scan click as a single-symbol analysis of symbol="SCAN".

const STAGE_A_CONCURRENCY = 10;
const STAGE_B_CONCURRENCY = 3;
// STAGE C: live MT5 order_check() broker preflight (spec: "TOP 10
// EXECUTABLE" fix) — only run against actionable, risk-pass candidates, so
// this is always a small set even at max shortlist size.
const PREFLIGHT_CONCURRENCY = 5;
// Enough completed bars for the EMA50/RSI14/ATR14/MACD(26+9) math used by
// both the AI's own MarketAnalysisPackage and the shortlist score to be
// meaningful — well below the 220 bars actually fetched per timeframe.
const MIN_BARS_REQUIRED = 60;
const MAX_QUOTE_AGE_SECONDS = 120;

// Exported so m5-opportunity-scan.ts (spec section 1/17: the M5-cycle-
// triggered sibling of this scanner) can reuse the exact same Stage A
// concurrency helper instead of duplicating it.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

export interface ScanCandidate {
  symbol: string;
  assetClass: string;
  eligible: boolean;
  reason: string | null;
  // Cheap technical shortlist score (shortlist-score.ts) — null when the
  // symbol was rejected before it could be computed. NEVER the final AI
  // profitability score; only used to rank which data-valid symbols are
  // worth an AI call.
  shortlistScore: number | null;
}

// Exported for m5-opportunity-scan.ts — a shortlisted candidate's already-
// fetched MarketAnalysisPackage is reused for both the M5-weighted shortlist
// score and (later) the shadow trade's feature_snapshot, never re-fetched.
export interface EvaluatedCandidate {
  candidate: ScanCandidate;
  pkg: MarketAnalysisPackage | null;
}

/**
 * STAGE A pre-filter for a single symbol (spec section 3/4): rejects before
 * ever considering an AI call if symbol_info is unavailable, trading is
 * disabled, the quote is missing/invalid/stale, spread is invalid/extreme,
 * or required M5/M15/H1/H4 candle data is unavailable. Uses only real
 * broker metadata (symbol_info/tick/bars) — never assumes symbol names or
 * behavior.
 */
async function evaluateCandidate(symbol: string, assetClass: string, maxSpreadPoints: number, requestId?: string): Promise<EvaluatedCandidate> {
  const reject = (reason: string): EvaluatedCandidate => ({ candidate: { symbol, assetClass, eligible: false, reason, shortlistScore: null }, pkg: null });
  try {
    const [market, symbolInfo] = await Promise.all([
      getMt5MarketStatus(symbol, requestId),
      getMt5SymbolInfo(symbol, requestId).catch(() => null),
    ]);
    if (!symbolInfo || !Number.isFinite(Number(symbolInfo.point))) {
      return reject('MT5 symbol_info is unavailable');
    }
    // ENUM_SYMBOL_TRADE_MODE: DISABLED=0, LONGONLY=1, SHORTONLY=2, CLOSEONLY=3, FULL=4.
    const tradeMode = Number(symbolInfo.trade_mode);
    if (tradeMode === 0) return reject('Trading is disabled for this symbol');
    if (tradeMode === 3) return reject('Symbol is close-only right now');

    if (market.market_status !== 'OPEN') return reject(`Market is ${String(market.market_status)}`);
    if (market.data_status !== 'LIVE') return reject(`Data is ${String(market.data_status)}`);

    // buildMarketAnalysisPackage also fetches the tick/point/candles this
    // stage needs, doubling as the exact input the cheap shortlist score is
    // computed from — no separate, duplicate data-fetching path. The same
    // `pkg` is also reused by the recent-analysis reuse cache below (its H1
    // lastClosedTime is the "same completed candle" dedup key), so a scan
    // never re-fetches MT5 candles twice for the same symbol.
    const pkg = await buildMarketAnalysisPackage(symbol, assetClass, requestId);
    const { bid, ask, spread, point, quoteAgeSeconds } = pkg.quote;
    if (bid === null || ask === null || bid <= 0 || ask <= 0 || ask < bid) {
      return reject('Quote bid/ask is missing or invalid');
    }
    if (quoteAgeSeconds !== null && quoteAgeSeconds > MAX_QUOTE_AGE_SECONDS) {
      return reject(`Quote is stale (${quoteAgeSeconds}s old)`);
    }
    if (spread !== null && spread < 0) return reject('Spread is invalid (negative)');
    if (point !== null && point > 0 && spread !== null) {
      const spreadPoints = spread / point;
      if (spreadPoints > maxSpreadPoints) return reject(`Spread too wide (${Math.round(spreadPoints)} points)`);
    }

    const badTimeframe = pkg.timeframes.find((tf) => tf.barCount < MIN_BARS_REQUIRED || tf.close === null);
    if (badTimeframe) return reject(`Insufficient ${badTimeframe.timeframe} candle data`);

    const { score } = computeShortlistScore(pkg);
    return { candidate: { symbol, assetClass, eligible: true, reason: null, shortlistScore: score }, pkg };
  } catch (err) {
    return reject((err as Error).message);
  }
}

// Exported for m5-opportunity-scan.ts — the Stage A MT5 pre-filter (spec
// section 3/4/19) is identical for both the manual and M5-cycle scanners;
// only what happens with the resulting shortlist (Stage B) differs.
export async function evaluateAllCandidates(pool: Pool, actor: Mt5Actor): Promise<{ evaluated: EvaluatedCandidate[]; discovered: number }> {
  const cfg = loadMt5RiskSettings();
  // The real, catalog-synced MT5 broker symbol list (spec section 3: "start
  // from actual symbols available from the connected MT5 DEMO account") —
  // instruments is only ever populated from a live symbols_get() sync, so
  // this can never contain a pseudo-symbol like SCAN/ALL/BEST/*.
  const instruments = await pool.query(
    `SELECT symbol, asset_class FROM instruments WHERE visible IS NOT FALSE ORDER BY symbol ASC`,
  );
  const evaluated = await mapWithConcurrency(instruments.rows, STAGE_A_CONCURRENCY, (row) =>
    evaluateCandidate(String(row.symbol), String(row.asset_class), cfg.mt5_max_spread_points, actor.requestId ?? undefined));
  return { evaluated, discovered: instruments.rows.length };
}

/**
 * Diagnostics-only listing of every real instrument's Stage A eligibility
 * (used by GET /mt5/ai-trade/candidates) — never itself triggers an AI call.
 */
export async function listScanCandidates(pool: Pool, actor: Mt5Actor): Promise<ScanCandidate[]> {
  const { evaluated } = await evaluateAllCandidates(pool, actor);
  return evaluated.map((e) => e.candidate);
}

export interface ScanResultRow {
  symbol: string;
  assetClass: string;
  decision: string;
  action: string | null;
  actionReason: string | null;
  confidencePct: number | null;
  // The AI's own, primary quality signal (spec section 1/2) — every
  // technically valid actionable row has one, never used to filter it out.
  tradeabilityPct: number | null;
  tradeabilityRating: string | null;
  tradeabilityRatingLabelTh: string | null;
  // "FIND BEST TRADES" ranking signal (spec sections 6-10) — what the TOP 10
  // is primarily sorted by. Independent of tradeabilityPct/confidencePct.
  profitabilityScore: number | null;
  // Kept only as a secondary, dataset-comparison diagnostic (spec section 16).
  tradeScore: number | null;
  tradeRating: string | null;
  tradeRatingLabelTh: string | null;
  entryType: string | null;
  pendingOrderType: string | null;
  currentPrice: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  planExpiry: string | null;
  planId: string | null;
  riskResult: string | null;
  riskFailedRules: string[] | null;
  riskReward: number | null;
  // Actual broker-aware money values (spec section 9) — computed server-side
  // by the Risk Engine from real MT5 symbol economics (contract size, tick
  // value), the same effective math as mt5.order_calc_profit(); never a
  // naive price_difference*lot calculation. Decimal strings (Postgres
  // NUMERIC-shaped), matching positionSizing.maximumPlannedLoss/targetProfit.
  maxLoss: string | null;
  targetProfit: string | null;
  // Broker-aware margin diagnostics (spec section 5) — sourced from the Risk
  // Engine's own snapshot, never re-derived here. marginShortfall is
  // marginRequired - freeMargin (0 when margin is sufficient).
  marginRequired: string | null;
  freeMargin: string | null;
  marginShortfall: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  reasonSummary: string | null;
  error: string | null;
  // True when this row was served from the recent-analysis reuse cache
  // (spec section 18) instead of a fresh OpenAI call this scan.
  reused: boolean;
  // Shadow Trades (spec sections 3/10): created for every technically-valid
  // actionable row regardless of riskResult, so AI learning never stops just
  // because the real DEMO account can't hold every candidate (POSITION_EXISTS/
  // INSUFFICIENT_MARGIN/MAX_SIMULTANEOUS_POSITIONS). Never implies a real
  // order was ever sent.
  shadowTradeActive: boolean;
  shadowTradeStatus: string | null;

  // --- "TOP 10 EXECUTABLE" fields (FIND BEST TRADES over-inclusion fix) ---
  // Alias of `decision` under the name the frontend spec asks for.
  side: string;
  // Broker-native lot size the Risk Engine actually sized this plan at —
  // needed to build the EXACT order_check() request runBrokerPreflight uses
  // (never a re-derived/approximate volume).
  recommendedVolume: string | null;
  // App-side readiness: riskResult === 'PASS' AND (for a reused/cached plan)
  // the underlying ai_trade_plans row is still WAITING_FOR_APPROVAL — never
  // already submitted/executed/expired/blocked by a prior click. This is
  // what stops FIND BEST TRADES from re-showing a plan that already failed
  // or already placed as if it were still a fresh, clickable card.
  demoExecutionReady: boolean;
  // Superset of riskFailedRules: also carries a stale-plan reason (e.g.
  // PLAN_ALREADY_EXECUTION_FAILED) and/or the broker preflight's own reason
  // when either applies.
  blockReasons: string[];
  // Result of a live MT5 order_check() against this row's EXACT order
  // request (see runBrokerPreflight) — only computed once demoExecutionReady
  // is true, since there is nothing to preflight for a row already blocked.
  brokerPreflightPass: boolean;
  // demoExecutionReady && brokerPreflightPass — the single authoritative
  // "safe to show as READY" flag. Independent of pendingOrderType: a
  // SELL_LIMIT row can be executableNow=true and still be excluded from the
  // main Top 10 by the separate BUY-LIMIT-ONLY MODE filter.
  executableNow: boolean;

  // --- Technical validation diagnostics (owner spec: "FIND BEST TRADES"
  // regression where every OpenAI result showed as generic "Technical
  // blocked") --- Every row carries these, always: technicalValid is true
  // only for ENTER_NOW/WAIT_FOR_ENTRY; technicalBlockCode is a specific,
  // stable code (never a blanket "Technical blocked") whenever it is false —
  // see ai-failure-classification.ts for the full code space, which spans
  // both a thrown exception (AI provider failure, schema validation failure)
  // and a successfully-parsed-but-NO_EXECUTION decision-policy result.
  technicalValid: boolean;
  technicalBlockCode: TechnicalBlockCode | null;
  technicalBlockMessage: string | null;

  // --- Final Quality Score fields (owner spec: REAL DEMO selectivity) ---
  // Only ever populated by the M5 cycle scanner (m5-opportunity-scan.ts) —
  // left undefined for the manual "FIND BEST TRADES" scanner, which does not
  // compute a Final Quality Score. Optional so every existing ScanResultRow
  // literal in this file stays valid without modification.
  finalQualityScore?: number | null;
  multiTimeframeAlignmentScore?: number | null;
  historicalPerformanceScore?: number | null;
  historicalAdjustment?: number | null;
  historicalAdjustmentReason?: string | null;
  riskTier?: 'HIGH' | 'NORMAL' | 'SHADOW_ONLY' | null;
  // True only for a row selected into this cycle's TOP N REAL DEMO
  // candidates (spec sections 21-22) — never simply "score >= threshold".
  realDemoEligible?: boolean;
  shadowOnlyReason?: string | null;
}

// Live MT5/DB account state fetched once per scan (spec section 6) — shared
// by the DEMO ACCOUNT CAPACITY summary and the reused-row risk freshness fix
// below, so every row/summary field in one scan reflects the same instant.
export interface LiveAccountState {
  status: Awaited<ReturnType<typeof getMt5Status>>;
  positions: Awaited<ReturnType<typeof listMt5Positions>>;
  pendingOrders: Awaited<ReturnType<typeof listMt5PendingOrders>>;
  tradesToday: number;
}

// DEMO ACCOUNT CAPACITY (spec section 8) — fetched once per scan from live
// MT5/DB state, never hidden or approximated. `demoVerified` gates whether
// the Fast Learning DEMO risk profile's loosened limits are actually in
// effect for maxSimultaneousPositions/maxTradesPerDay (see
// effectiveMt5RiskSettings).
export interface ScanCapacity {
  demoVerified: boolean;
  openPositions: number;
  maxSimultaneousPositions: number;
  availablePositionSlots: number;
  pendingOrders: number;
  tradesToday: number;
  maxTradesPerDay: number;
  freeMargin: number | null;
  equity: number | null;
  fastLearningRiskProfileEnabled: boolean;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// Section 2 of the "FIND BEST TRADES" diagnostics fix: "Technical blocked:
// 20 / Breakdown: CODE: count, CODE: count" — grouped by each row's own
// technicalBlockCode, never collapsed into one undifferentiated total.
function technicalBlockBreakdownOf(rows: ScanResultRow[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const row of rows) {
    const code = row.technicalBlockCode ?? 'UNKNOWN_ERROR';
    breakdown[code] = (breakdown[code] ?? 0) + 1;
  }
  return breakdown;
}

// Exported for m5-opportunity-scan.ts — identical row-shaping from a fresh
// analyzeSymbolWithAI() result regardless of which cadence triggered it.
export function toScanRow(symbol: string, assetClass: string, detail: AiTradePlanDetail | { aiConfigured: false; message: string }, providerInfo: { provider: string | null; model: string | null }): ScanResultRow {
  const empty: ScanResultRow = {
    symbol, assetClass, decision: 'ERROR', action: null, actionReason: null, confidencePct: null,
    tradeabilityPct: null, tradeabilityRating: null, tradeabilityRatingLabelTh: null, profitabilityScore: null,
    tradeScore: null, tradeRating: null, tradeRatingLabelTh: null, entryType: null, pendingOrderType: null,
    currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null, planExpiry: null, planId: null,
    riskResult: null, riskFailedRules: null, riskReward: null, maxLoss: null, targetProfit: null,
    marginRequired: null, freeMargin: null, marginShortfall: null,
    aiProvider: providerInfo.provider, aiModel: providerInfo.model, aiPromptVersion: PROMPT_VERSION,
    reasonSummary: null, error: null, reused: false, shadowTradeActive: false, shadowTradeStatus: null,
    side: 'ERROR', recommendedVolume: null, demoExecutionReady: false, blockReasons: [], brokerPreflightPass: false, executableNow: false,
    technicalValid: false, technicalBlockCode: null, technicalBlockMessage: null,
  };
  if ('aiConfigured' in detail && detail.aiConfigured === false) {
    return { ...empty, error: detail.message, technicalBlockCode: 'AI_PROVIDER_NOT_CONFIGURED', technicalBlockMessage: detail.message };
  }
  const snap = (detail.risk as { snapshot?: Record<string, unknown> }).snapshot;
  return {
    ...empty,
    ...technicalStatusForAction(detail.action.action, detail.action.reason),
    decision: detail.decision.direction,
    action: detail.action.action,
    actionReason: detail.action.reason,
    confidencePct: detail.decision.confidencePct,
    tradeabilityPct: detail.tradeability?.tradeabilityPct ?? null,
    tradeabilityRating: detail.tradeability?.rating ?? null,
    tradeabilityRatingLabelTh: detail.tradeability?.ratingLabelTh ?? null,
    profitabilityScore: detail.profitability?.profitabilityScore ?? null,
    tradeScore: detail.tradeScore?.tradeScore ?? null,
    tradeRating: detail.tradeScore?.tradeRating ?? null,
    tradeRatingLabelTh: detail.tradeScore?.tradeRatingLabelTh ?? null,
    entryType: (detail.entryPlan.entry_type as string) ?? null,
    pendingOrderType: (detail.entryPlan.pending_order_type as string) ?? null,
    currentPrice: detail.quote.currentPrice,
    entryPrice: numOrNull(detail.entryPlan.entry_price) ?? numOrNull(detail.entryPlan.entry_zone_high) ?? numOrNull(detail.entryPlan.trigger_price),
    stopLoss: detail.protection.stopLoss,
    takeProfit: detail.protection.takeProfit,
    planExpiry: strOrNull(detail.entryPlan.plan_expiry),
    planId: detail.planId,
    riskResult: (detail.risk.result as string) ?? null,
    riskFailedRules: Array.isArray(detail.risk.failedRules) ? (detail.risk.failedRules as string[]) : null,
    riskReward: detail.protection.riskReward,
    maxLoss: strOrNull(detail.positionSizing.maximumPlannedLoss),
    targetProfit: strOrNull(detail.positionSizing.targetProfit),
    marginRequired: strOrNull(snap?.marginRequired),
    freeMargin: strOrNull(snap?.freeMargin),
    marginShortfall: strOrNull(snap?.marginShortfall),
    reasonSummary: detail.explanation.summary,
    side: detail.decision.direction,
    recommendedVolume: strOrNull((detail.positionSizing as Record<string, unknown>).recommendedLotSize),
    demoExecutionReady: detail.risk.result === 'PASS',
    blockReasons: Array.isArray(detail.risk.failedRules) ? (detail.risk.failedRules as string[]) : [],
  };
}

/**
 * Reconstructs a ScanResultRow directly from a previously-persisted
 * ai_trade_plans row (spec section 18 reuse cache) — no AiTradePlanDetail
 * object exists for a reused row (no fresh analyzeSymbolWithAI call was
 * made), so this maps the same DB columns trading-ai-service.ts itself
 * already wrote when that plan was first created.
 */
// Exported for m5-opportunity-scan.ts's own M5-keyed reuse cache.
export function toScanRowFromPlanRow(symbol: string, assetClass: string, row: Record<string, unknown>): ScanResultRow {
  // risk_result/risk_failed_rules/max_planned_loss/margin fields below are
  // the STALE values from when this plan was first created — callers that
  // care about current risk freshness (runOpportunityScan, spec section 6)
  // must overwrite them with reevaluateRiskForReusedPlan's fresh result
  // before this row is shown to the owner. Never trusted as a real-time
  // account/margin/position read on its own.
  const snap = row.risk_snapshot as Record<string, unknown> | null | undefined;
  const tradeabilityPctRaw = numOrNull(row.tradeability_pct);
  const tradeability = tradeabilityPctRaw !== null ? deriveTradeability(tradeabilityPctRaw) : null;
  const profitabilityRaw = numOrNull(row.profitability_score);
  const profitability = profitabilityRaw !== null ? deriveProfitability(profitabilityRaw) : null;
  const tradeScoreRaw = numOrNull(row.trade_score);
  const tradeRating = row.trade_rating ? (String(row.trade_rating) as TradeRating) : (tradeScoreRaw !== null ? tradeRatingFor(tradeScoreRaw) : null);
  return {
    symbol, assetClass,
    ...technicalStatusForAction(strOrNull(row.action), strOrNull(row.action_reason)),
    decision: String(row.decision),
    action: strOrNull(row.action),
    actionReason: strOrNull(row.action_reason),
    confidencePct: numOrNull(row.confidence_pct),
    tradeabilityPct: tradeability?.tradeabilityPct ?? null,
    tradeabilityRating: tradeability?.rating ?? null,
    tradeabilityRatingLabelTh: tradeability?.ratingLabelTh ?? null,
    profitabilityScore: profitability?.profitabilityScore ?? null,
    tradeScore: tradeScoreRaw,
    tradeRating,
    tradeRatingLabelTh: tradeRating ? TRADE_RATING_LABEL_TH[tradeRating] : null,
    entryType: strOrNull(row.entry_type),
    pendingOrderType: strOrNull(row.pending_order_type),
    currentPrice: numOrNull(row.current_price),
    entryPrice: numOrNull(row.entry_price) ?? numOrNull(row.entry_zone_high) ?? numOrNull(row.trigger_price),
    stopLoss: numOrNull(row.stop_loss),
    takeProfit: numOrNull(row.take_profit),
    planExpiry: strOrNull(row.plan_expiry),
    planId: strOrNull(row.id),
    riskResult: strOrNull(row.risk_result),
    riskFailedRules: Array.isArray(row.risk_failed_rules) ? (row.risk_failed_rules as string[]) : null,
    riskReward: numOrNull(row.risk_reward),
    maxLoss: strOrNull(row.max_planned_loss),
    targetProfit: strOrNull(row.target_profit),
    marginRequired: strOrNull(snap?.marginRequired),
    freeMargin: strOrNull(snap?.freeMargin),
    marginShortfall: strOrNull(snap?.marginShortfall),
    aiProvider: strOrNull(row.ai_provider),
    aiModel: strOrNull(row.ai_model),
    aiPromptVersion: strOrNull(row.ai_prompt_version),
    reasonSummary: strOrNull(row.reason_summary),
    error: null,
    reused: true,
    shadowTradeActive: false,
    shadowTradeStatus: null,
    side: String(row.decision),
    recommendedVolume: strOrNull(row.recommended_volume),
    demoExecutionReady: row.risk_result === 'PASS',
    blockReasons: Array.isArray(row.risk_failed_rules) ? (row.risk_failed_rules as string[]) : [],
    brokerPreflightPass: false,
    executableNow: false,
  };
}

/**
 * Risk precheck freshness (spec section 6, "AI CACHE and RISK CACHE must be
 * separate"): re-runs the Risk Engine for a reused/cached plan against LIVE
 * account state (positions, pending orders, trades today, margin, quote)
 * instead of trusting the persisted risk_result/risk_failed_rules, which are
 * stale from whenever this plan was first created. The AI's own decision/
 * entry/SL/TP/RR are taken as-is from the cached row — only the risk
 * verdict is ever recomputed here. Mirrors the exact same evaluateMt5Risk +
 * duplicateSymbol pattern trading-ai-service.ts's analyzeSymbolWithAI uses.
 */
export async function reevaluateRiskForReusedPlan(
  planRow: Record<string, unknown>,
  liveState: LiveAccountState,
  riskSettings: Record<string, unknown>,
  requestId?: string,
): Promise<{ riskResult: 'PASS' | 'REJECT'; riskFailedRules: string[]; maxLoss: string; marginRequired: string | null; freeMargin: string | null; marginShortfall: string | null }> {
  const symbol = String(planRow.symbol);
  const symbolInfoRaw = await getMt5SymbolInfo(symbol, requestId).catch(() => null);
  const referenceEntry = numOrNull(planRow.entry_price) ?? numOrNull(planRow.entry_zone_high) ?? numOrNull(planRow.trigger_price) ?? numOrNull(planRow.current_price);
  const risk = evaluateMt5Risk({
    decision: (planRow.decision as 'BUY' | 'SELL' | 'HOLD' | 'NO_TRADE') ?? 'HOLD',
    referenceEntry: String(referenceEntry ?? 0),
    stopLoss: planRow.stop_loss !== null && planRow.stop_loss !== undefined ? String(planRow.stop_loss) : null,
    takeProfit: planRow.take_profit !== null && planRow.take_profit !== undefined ? String(planRow.take_profit) : null,
    riskReward: planRow.risk_reward !== null && planRow.risk_reward !== undefined ? String(planRow.risk_reward) : null,
    confidence: numOrNull(planRow.confidence_pct) ?? 0,
    account: liveState.status.account,
    terminal: liveState.status.terminal,
    settings: riskSettings,
    openPositions: liveState.positions.length,
    tradesToday: liveState.tradesToday,
    // Matches analyzeSymbolWithAI's own evaluateMt5Risk call exactly (see
    // trading-ai-service.ts) — account-level connected/demo_verified, not
    // this specific symbol's live session status.
    marketStatus: liveState.status.connected ? 'OPEN' : 'UNKNOWN',
    dataStatus: liveState.status.demo_verified ? 'LIVE' : 'DISCONNECTED',
    symbol: toRiskSymbolInfo(symbolInfoRaw),
    leverage: Number(liveState.status.account?.leverage) || null,
  });
  const duplicateSymbol = liveState.positions.some((p) => String(p.symbol) === symbol) || liveState.pendingOrders.some((o) => String(o.symbol) === symbol);
  const riskFailedRules = [...risk.failedRules, ...(duplicateSymbol ? ['POSITION_EXISTS'] : [])];
  const snap = risk.snapshot as Record<string, unknown>;
  return {
    riskResult: riskFailedRules.length ? 'REJECT' : 'PASS',
    riskFailedRules,
    maxLoss: risk.riskAmount,
    marginRequired: strOrNull(snap.marginRequired),
    freeMargin: strOrNull(snap.freeMargin),
    marginShortfall: strOrNull(snap.marginShortfall),
  };
}

/**
 * Recent-analysis reuse cache (spec section 18: "do not analyze the same
 * symbol repeatedly on the same completed market data unless the user
 * explicitly requests refresh/analyze again"). Only ever consulted from
 * runOpportunityScan — a single-symbol ANALYZE WITH AI / VIEW PLAN call
 * always goes straight through analyzeSymbolWithAI, matching the "explicit
 * refresh" carve-out. Only reuses an actionable (BUY/SELL) plan: a WAIT
 * result produces no ai_trade_plans row and is cheap enough to just
 * re-derive fresh each scan, and WAIT results are never part of the ranked
 * TOP 10 output anyway.
 */
// Generalized so m5-opportunity-scan.ts can key the same reuse-cache pattern
// off each symbol's own M5 lastClosedTime instead of H1's (spec section 1:
// "deduplicate by symbol + completed M5 candle timestamp") — exported for
// that purpose. The manual scanner keeps calling this with timeframe='H1'.
export async function findReusablePlanForTimeframe(
  pool: Pool,
  symbol: string,
  timeframe: 'M5' | 'H1',
  lastClosedTime: string | null,
  maxAgeMinutes: number,
): Promise<Record<string, unknown> | null> {
  if (!lastClosedTime) return null;
  const result = await pool.query(
    `SELECT p.* FROM ai_trade_plans p
     JOIN ai_analysis_runs r ON r.id = p.analysis_run_id
     WHERE p.symbol = $1
       AND p.decision IN ('BUY','SELL')
       AND p.created_at >= now() - ($4 || ' minutes')::interval
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.market_analysis_package->'timeframes') elem
         WHERE elem->>'timeframe' = $2 AND elem->>'lastClosedTime' = $3
       )
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [symbol, timeframe, lastClosedTime, maxAgeMinutes],
  );
  return result.rows[0] ?? null;
}

function findReusablePlan(pool: Pool, symbol: string, h1LastClosedTime: string | null, maxAgeMinutes: number): Promise<Record<string, unknown> | null> {
  return findReusablePlanForTimeframe(pool, symbol, 'H1', h1LastClosedTime, maxAgeMinutes);
}

/**
 * Ranks by tradeability_pct descending (spec section 15, unchanged for the
 * Home page's "AI TOP OPPORTUNITIES" widget — see getTopOpportunities below)
 * — never by raw AI confidence. Ties broken by confidence, then risk/reward.
 * Rows with no tradeability_pct (errors) sort last. Kept separate from
 * rankByProfitability, which is what "FIND BEST TRADES" itself uses.
 */
export function rankByTradeability(rows: ScanResultRow[]): ScanResultRow[] {
  return [...rows].sort((a, b) => {
    const tradeabilityDiff = (b.tradeabilityPct ?? -1) - (a.tradeabilityPct ?? -1);
    if (tradeabilityDiff !== 0) return tradeabilityDiff;
    const confidenceDiff = (b.confidencePct ?? -1) - (a.confidencePct ?? -1);
    if (confidenceDiff !== 0) return confidenceDiff;
    return (b.riskReward ?? -1) - (a.riskReward ?? -1);
  });
}

/**
 * "FIND BEST TRADES" ranking (spec section 10, CRITICAL): primary sort is
 * profitability_score descending — NEVER raw dollar target_profit, which
 * would let symbols with larger contract sizes/volatility dominate purely
 * from position-size arithmetic rather than genuine opportunity quality.
 * Tie-breakers only: tradeability_pct, then confidence_pct, then
 * risk_reward. Rows with no profitability_score (errors) sort last. Never
 * mutates the input array.
 */
export function rankByProfitability(rows: ScanResultRow[]): ScanResultRow[] {
  return [...rows].sort((a, b) => {
    const profitabilityDiff = (b.profitabilityScore ?? -1) - (a.profitabilityScore ?? -1);
    if (profitabilityDiff !== 0) return profitabilityDiff;
    const tradeabilityDiff = (b.tradeabilityPct ?? -1) - (a.tradeabilityPct ?? -1);
    if (tradeabilityDiff !== 0) return tradeabilityDiff;
    const confidenceDiff = (b.confidencePct ?? -1) - (a.confidencePct ?? -1);
    if (confidenceDiff !== 0) return confidenceDiff;
    return (b.riskReward ?? -1) - (a.riskReward ?? -1);
  });
}

const ACTIONABLE_ACTIONS = new Set(['ENTER_NOW', 'WAIT_FOR_ENTRY']);

export interface ScanSummary {
  symbolsDiscovered: number;
  dataValid: number;
  aiShortlisted: number;
  actionable: number;
  enterNow: number;
  waitForEntry: number;
  // Genuine technical impossibility only (spec section 7/17) — a
  // successfully-parsed AI result that decision-policy.ts still could not
  // turn into ENTER_NOW/WAIT_FOR_ENTRY (WAIT/NO_ENTRY, MARKET_CLOSED,
  // STALE_QUOTE), OR a thrown schema-validation/unknown-symbol failure.
  // NEVER includes an AI-provider-layer failure (auth/billing/rate-limit/
  // timeout/invalid-response/not-configured) — see aiProviderErrors below.
  // This is the exact regression fix: those used to be silently counted
  // here too.
  technicalBlocked: number;
  // Breakdown of `technicalBlocked` by exact technicalBlockCode (spec
  // section 2) — e.g. {"SCHEMA_VALIDATION_FAILED": 3, "NO_ACTIONABLE_PLAN": 5}.
  technicalBlockBreakdown: Record<string, number>;
  // AI-provider-layer failures — the AI service itself could not be
  // reached/authenticated/billed, or its response was unusable. A row here
  // says nothing about the underlying trade setup's quality; it means the
  // AI was never successfully consulted at all this scan.
  aiProviderErrors: number;
  aiProviderErrorBreakdown: Record<string, number>;
  // Independent of `action` (spec section 8): a Risk-Engine REJECT can occur
  // on an otherwise-actionable row without changing its action.
  riskPass: number;
  riskBlocked: number;
  // How many of the shortlisted symbols were actually billed to OpenAI this
  // scan (spec section 17/18) — excludes rows served from the reuse cache.
  openAiRequestsUsed: number;
  reusedFromCache: number;
  // Section 10 counters: never conflate "valid plan of a non-BUY-LIMIT order
  // type" with a technical failure — a valid SELL_LIMIT/BUY_STOP/SELL_STOP/
  // MARKET_NOW plan is simply not part of the current BUY-LIMIT-ONLY primary
  // view, it is NOT technically blocked.
  aiPlanValid: number; // == actionable.length; explicit alias for UI clarity
  buyLimitValidCount: number;
  otherOrderTypeValidCount: number;
  // "TOP 10 EXECUTABLE" fix: topOpportunitiesShown is now always <=10 and
  // only counts truly executableNow BUY_LIMIT rows (never a blocked card).
  topOpportunitiesShown: number;
  // Total executableNow && pendingOrderType==='BUY_LIMIT' rows found this
  // scan, BEFORE the top-10 cap — lets the UI say "found: X" honestly even
  // when X > 10 (topOpportunitiesShown is still only ever <=10).
  executableBuyLimitFound: number;
}

export interface OpportunityScanResult {
  scanId: string;
  summary: ScanSummary;
  // "TOP 10 EXECUTABLE" (product fix): ONLY rows with executableNow===true
  // AND pendingOrderType==='BUY_LIMIT' (BUY-LIMIT-ONLY MODE), ranked by
  // profitabilityScore descending, hard-capped at 10. A card here is safe to
  // present as READY — it already passed the Risk Engine, is not a
  // stale/already-processed reused plan, and passed a live MT5
  // order_check() against its exact order request. Never contains a blocked
  // row. Never fabricated: if fewer than 10 executable BUY_LIMIT candidates
  // exist, this is simply shorter than 10.
  topOpportunities: ScanResultRow[];
  // Every technically valid actionable (ENTER_NOW/WAIT_FOR_ENTRY) row from
  // this scan, unbounded and Risk-PASS/BLOCKED/executable/non-executable
  // mixed together — a superset of topOpportunities, kept so the UI can
  // offer "show all AI picks" filters beyond the TOP 10.
  actionable: ScanResultRow[];
  // actionable rows NOT included in topOpportunities (blocked, non-BUY_LIMIT,
  // or broker-preflight-failed) — for the "Other AI plans (blocked / not
  // executable now)" collapsible debug section. Never merged into the main
  // ranked list.
  otherIdeas: ScanResultRow[];
  // action=NO_EXECUTION rows — genuine technical impossibility only. Never
  // includes an AI-provider-layer failure — see aiErrors.
  rejected: ScanResultRow[];
  // AI-provider-layer failures (auth/billing/rate-limit/timeout/invalid
  // response/not-configured) — kept separate from `rejected` so the
  // "TECHNICAL DIAGNOSTICS" UI can show them under their own heading instead
  // of a misleading "Technical blocked" label.
  aiErrors: ScanResultRow[];
  dataRejected: ScanCandidate[];
  // DEMO ACCOUNT CAPACITY (spec section 8) — never derived from stale/cached
  // rows, always the same live snapshot fetched once at the top of this scan.
  capacity: ScanCapacity;
}

export async function runOpportunityScan(pool: Pool, actor: Mt5Actor, shortlistSize?: number): Promise<OpportunityScanResult> {
  const scanId = crypto.randomUUID();
  const scannerSettings = loadAiScannerSettings();
  const maxCandidates = shortlistSize ?? scannerSettings.ai_best_trades_shortlist_size;
  const topCount = scannerSettings.ai_best_trades_top_count;
  const providerInfo = describeTradingAIProvider();

  // Live account state (spec sections 2, 6, 8) — fetched exactly once so the
  // capacity summary and every reused-row risk recompute in this scan agree
  // with each other, never a stale snapshot from a prior candle/scan.
  const [status, positions, pendingOrders, tradesToday] = await Promise.all([
    getMt5Status(actor.requestId ?? undefined),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    countTradesToday(pool),
  ]);
  const liveState: LiveAccountState = { status, positions, pendingOrders, tradesToday };
  const riskSettings = effectiveMt5RiskSettings(status.demo_verified);
  const riskSettingsRecord = riskSettings as unknown as Record<string, unknown>;
  const capacity: ScanCapacity = {
    demoVerified: status.demo_verified,
    openPositions: positions.length,
    maxSimultaneousPositions: riskSettings.mt5_max_simultaneous_positions,
    availablePositionSlots: Math.max(0, riskSettings.mt5_max_simultaneous_positions - positions.length),
    pendingOrders: pendingOrders.length,
    tradesToday,
    maxTradesPerDay: riskSettings.mt5_max_trades_per_day,
    freeMargin: numOrNull(status.account?.margin_free ?? status.account?.free_margin),
    equity: numOrNull(status.account?.equity ?? status.account?.balance),
    fastLearningRiskProfileEnabled: riskSettings.fast_learning_risk_profile_enabled,
  };

  const { evaluated, discovered } = await evaluateAllCandidates(pool, actor);
  const dataRejected = evaluated.filter((e) => !e.candidate.eligible).map((e) => e.candidate);
  const dataValid = evaluated.filter((e) => e.candidate.eligible);

  // Rank by the cheap technical shortlist score and cap to the configured
  // AI budget (spec section 5/14) — this is the primary gate on how many
  // paid OpenAI calls a single "FIND BEST TRADES" click can ever produce.
  const shortlisted = [...dataValid]
    .sort((a, b) => (b.candidate.shortlistScore ?? -1) - (a.candidate.shortlistScore ?? -1))
    .slice(0, maxCandidates);

  let openAiRequestsUsed = 0;
  let reusedFromCache = 0;

  const rows = await mapWithConcurrency(shortlisted, STAGE_B_CONCURRENCY, async (entry): Promise<ScanResultRow> => {
    const h1LastClosedTime = entry.pkg?.timeframes.find((tf) => tf.timeframe === 'H1')?.lastClosedTime ?? null;
    try {
      const reusable = await findReusablePlan(pool, entry.candidate.symbol, h1LastClosedTime, scannerSettings.ai_best_trades_reuse_max_age_minutes);
      if (reusable) {
        reusedFromCache += 1;
        const cachedRow = toScanRowFromPlanRow(entry.candidate.symbol, entry.candidate.assetClass, reusable);
        // Risk precheck freshness (spec section 6): the AI analysis is
        // reused, but its risk verdict never is — always recomputed against
        // the live account state fetched above, never the stale persisted
        // risk_result/risk_failed_rules from whenever this plan was first
        // created.
        const freshRisk = await reevaluateRiskForReusedPlan(reusable, liveState, riskSettingsRecord, actor.requestId ?? undefined);
        const merged = { ...cachedRow, ...freshRisk };
        // "Card looked ready, click failed" root cause: the reuse cache
        // (findReusablePlan) selects the latest plan for this symbol/candle
        // by created_at ALONE, with no status filter — it can resurface a
        // plan that already went through approval and ended
        // PENDING_ORDER_PLACED/POSITION_OPEN/EXECUTION_FAILED (e.g.
        // PENDING_ORDER_NOT_CONFIRMED, a BROKER_NONSTANDARD_RETCODE_ZERO
        // order_send) on a PRIOR click. Only a plan still sitting untouched
        // in WAITING_FOR_APPROVAL is actually fresh/clickable; anything else
        // must never be presented as demoExecutionReady again.
        const planStatus = String(reusable.status ?? '');
        const demoExecutionReady = merged.riskResult === 'PASS' && planStatus === 'WAITING_FOR_APPROVAL';
        const blockReasons = [...(merged.riskFailedRules ?? [])];
        if (planStatus !== 'WAITING_FOR_APPROVAL') {
          blockReasons.push(reusable.blocked_reason ? `PLAN_ALREADY_${planStatus}: ${String(reusable.blocked_reason)}` : `PLAN_ALREADY_${planStatus}`);
        }
        return { ...merged, demoExecutionReady, blockReasons };
      }
      openAiRequestsUsed += 1;
      const detail = await analyzeSymbolWithAI(pool, entry.candidate.symbol, actor);
      return toScanRow(entry.candidate.symbol, entry.candidate.assetClass, detail, providerInfo);
    } catch (err) {
      // Regression fix: every thrown exception here used to become an
      // undifferentiated "ERROR" row, silently counted as generic
      // "Technical blocked" in the summary below regardless of WHY it
      // failed — an AI provider outage/rate-limit/billing issue (nothing
      // wrong with any trade plan; the AI was never even reached) looked
      // identical to a genuine "no valid plan could be constructed" result.
      // classifyAiFailure gives every failure an exact, stable code so the
      // two are never conflated again.
      const classified = classifyAiFailure(err);
      return {
        symbol: entry.candidate.symbol, assetClass: entry.candidate.assetClass, decision: 'ERROR', action: null, actionReason: null, confidencePct: null,
        tradeabilityPct: null, tradeabilityRating: null, tradeabilityRatingLabelTh: null, profitabilityScore: null,
        tradeScore: null, tradeRating: null, tradeRatingLabelTh: null, entryType: null, pendingOrderType: null,
        currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null, planExpiry: null, planId: null,
        riskResult: null, riskFailedRules: null, riskReward: null, maxLoss: null, targetProfit: null,
        marginRequired: null, freeMargin: null, marginShortfall: null,
        aiProvider: providerInfo.provider, aiModel: providerInfo.model, aiPromptVersion: PROMPT_VERSION,
        reasonSummary: null, error: classified.message, reused: false,
        shadowTradeActive: false, shadowTradeStatus: null,
        side: 'ERROR', recommendedVolume: null, demoExecutionReady: false, blockReasons: [], brokerPreflightPass: false, executableNow: false,
        technicalValid: false, technicalBlockCode: classified.technicalBlockCode, technicalBlockMessage: classified.message,
      };
    }
  });

  const actionable = rankByProfitability(rows.filter((r) => r.action !== null && ACTIONABLE_ACTIONS.has(r.action)));
  // AI-provider-layer failures (auth/billing/rate-limit/timeout/invalid
  // response/not-configured) are their OWN bucket, never "Technical
  // blocked" — see aiErrors below and classifyAiFailure's own doc comment
  // for the exact regression this fixes.
  const aiErrorRows = rows.filter((r) => r.technicalBlockCode !== null && AI_PROVIDER_ERROR_CODE_SET.has(r.technicalBlockCode));
  const rejected = rows.filter((r) => (r.action === 'NO_EXECUTION' || r.action === null) && !(r.technicalBlockCode !== null && AI_PROVIDER_ERROR_CODE_SET.has(r.technicalBlockCode)));
  const riskPassRows = actionable.filter((r) => r.riskResult === 'PASS');

  // STAGE C — broker preflight (spec: "TOP 10 EXECUTABLE" fix). Only a row
  // that is already demoExecutionReady (fresh risk PASS, and for a reused
  // plan, still WAITING_FOR_APPROVAL — see above) gets a live MT5
  // order_check() against its EXACT order request; every other row is
  // skipped (no broker call wasted on something already blocked) and stays
  // executableNow=false. Mutates the row objects in place — `actionable`,
  // `rejected`/`rows` all share the same references, matching the Shadow
  // Trade wiring below.
  await mapWithConcurrency(actionable, PREFLIGHT_CONCURRENCY, async (row): Promise<null> => {
    if (!row.demoExecutionReady) return null;
    const input: BrokerPreflightInput = {
      symbol: row.symbol,
      decision: row.side === 'SELL' ? 'SELL' : 'BUY',
      entryType: row.entryType,
      pendingOrderType: row.pendingOrderType,
      referenceEntry: row.entryPrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      planExpiry: row.planExpiry,
      volume: row.recommendedVolume !== null ? Number(row.recommendedVolume) : null,
    };
    const preflight = await runBrokerPreflight(input, actor.requestId ?? undefined);
    row.brokerPreflightPass = preflight.brokerPreflightPass;
    row.executableNow = preflight.brokerPreflightPass;
    if (!preflight.brokerPreflightPass && preflight.reason) row.blockReasons.push(preflight.reason);
    return null;
  });

  // "TOP 10 EXECUTABLE" (product fix — no more blocked cards mixed into the
  // ranked list, and cards that look ready must never fail on click):
  // executableNow already requires riskResult PASS + a fresh/untouched
  // reused plan + a live broker order_check() PASS. BUY-LIMIT-ONLY MODE
  // additionally restricts the MAIN ranked list to pending_order_type ===
  // 'BUY_LIMIT' for now (a SELL_LIMIT/BUY_STOP/SELL_STOP row can still be
  // executableNow=true — it is just not shown here yet). Already
  // profitability-ranked via rankByProfitability above; filtering preserves
  // that order. Hard-capped at 10 regardless of AI_BEST_TRADES_TOP_COUNT.
  const executableBuyLimit = actionable.filter((r) => r.executableNow && r.pendingOrderType === 'BUY_LIMIT');
  const topOpportunities = executableBuyLimit.slice(0, Math.min(topCount, 10));
  // Every other actionable row (blocked, non-BUY_LIMIT, or preflight-failed)
  // — kept for the "Other AI plans (blocked / not executable now)"
  // collapsible debug section, never silently discarded.
  const topOpportunityIds = new Set(topOpportunities);
  const otherIdeas = actionable.filter((r) => !topOpportunityIds.has(r));

  // Shadow Trades (spec sections 3/10): every technically-valid actionable
  // row gets an automatic, simulated trade — regardless of riskResult, so
  // POSITION_EXISTS/INSUFFICIENT_MARGIN/MAX_SIMULTANEOUS_POSITIONS never stop
  // AI learning just because the real DEMO account can't physically hold
  // every candidate. Mirrors m5-opportunity-scan.ts's own wiring of the same
  // shadow-trade-service.ts helper — never calls order_send (see that file's
  // own doc comment). Best-effort: a shadow-trade failure never fails the
  // scan itself.
  try {
    const packagesBySymbol = new Map(shortlisted.filter((e) => e.pkg).map((e) => [e.candidate.symbol, e.pkg!]));
    const candleTimestamp = shortlisted
      .map((e) => e.pkg?.timeframes.find((tf) => tf.timeframe === 'H1')?.lastClosedTime)
      .find((t): t is string => Boolean(t)) ?? new Date().toISOString();
    await createShadowTradesForCycle(pool, actionable, packagesBySymbol, candleTimestamp);

    const planIds = actionable.map((r) => r.planId).filter((id): id is string => Boolean(id));
    if (planIds.length) {
      const shadowRows = await pool.query(
        `SELECT ai_trade_plan_id, status FROM shadow_trades WHERE ai_trade_plan_id = ANY($1::uuid[])`,
        [planIds],
      );
      const shadowBySymbolPlan = new Map(shadowRows.rows.map((r) => [String(r.ai_trade_plan_id), String(r.status)]));
      for (const r of rows) {
        const shadowStatus = r.planId ? shadowBySymbolPlan.get(r.planId) ?? null : null;
        r.shadowTradeActive = shadowStatus !== null;
        r.shadowTradeStatus = shadowStatus;
      }
    }
  } catch (err) {
    console.error('[opportunity-scan] shadow trade creation failed (non-fatal):', (err as Error).message);
  }

  // Dataset persistence (spec section 20): freeze the exact ranking context
  // shown to the owner for this scan, independent of ai_trade_plans' own
  // later lifecycle (approved/executed/expired), so rank #1-3 vs #8-10
  // real-outcome comparisons stay possible even after those plans change
  // status or expire.
  if (topOpportunities.length) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    topOpportunities.forEach((r, index) => {
      const rank = index + 1;
      const base = values.length;
      values.push(
        scanId, rank, r.planId, r.symbol, r.assetClass, r.decision, r.action,
        r.profitabilityScore, r.tradeabilityPct, r.confidencePct,
        r.entryPrice, r.stopLoss, r.takeProfit, r.riskReward, r.maxLoss, r.targetProfit,
        r.riskResult, r.aiProvider ?? providerInfo.provider ?? 'unknown', r.aiModel ?? providerInfo.model ?? 'unknown', r.aiPromptVersion ?? PROMPT_VERSION,
      );
      const cols = Array.from({ length: 20 }, (_, i) => `$${base + i + 1}`);
      placeholders.push(`(${cols.join(',')})`);
    });
    await pool.query(
      `INSERT INTO opportunity_scan_results(
         scan_id, rank, ai_trade_plan_id, symbol, asset_class, direction, action,
         profitability_score, tradeability_pct, confidence_pct,
         entry_price, stop_loss, take_profit, risk_reward, max_loss, target_profit,
         risk_result, ai_provider, ai_model, ai_prompt_version)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  const buyLimitValid = actionable.filter((r) => r.pendingOrderType === 'BUY_LIMIT');

  const summary: ScanSummary = {
    symbolsDiscovered: discovered,
    dataValid: dataValid.length,
    aiShortlisted: shortlisted.length,
    actionable: actionable.length,
    enterNow: rows.filter((r) => r.action === 'ENTER_NOW').length,
    waitForEntry: rows.filter((r) => r.action === 'WAIT_FOR_ENTRY').length,
    technicalBlocked: rejected.length,
    technicalBlockBreakdown: technicalBlockBreakdownOf(rejected),
    aiProviderErrors: aiErrorRows.length,
    aiProviderErrorBreakdown: technicalBlockBreakdownOf(aiErrorRows),
    riskPass: riskPassRows.length,
    riskBlocked: actionable.filter((r) => r.riskResult !== 'PASS').length,
    openAiRequestsUsed,
    reusedFromCache,
    aiPlanValid: actionable.length,
    buyLimitValidCount: buyLimitValid.length,
    otherOrderTypeValidCount: actionable.length - buyLimitValid.length,
    topOpportunitiesShown: topOpportunities.length,
    executableBuyLimitFound: executableBuyLimit.length,
  };

  return { scanId, summary, topOpportunities, actionable, otherIdeas, rejected, aiErrors: aiErrorRows, dataRejected, capacity };
}

/**
 * Home page "AI TOP OPPORTUNITIES": a passive read of the most recent
 * persisted analysis per watchlist symbol, ranked by tradeability_pct. Never
 * triggers a new AI call itself (spec section 11).
 */
export async function getTopOpportunities(pool: Pool, limit = 3, maxAgeHours = 12): Promise<ScanResultRow[]> {
  // Regression fix: `limit` was previously passed as an unused $1 SQL bind
  // parameter — the query text never references $1 anywhere (LIMIT 200 is
  // a hardcoded ranking-headroom cap; `limit` is only ever applied to the
  // final in-memory slice below). Postgres cannot infer a type for a bound
  // parameter that never appears in the query text, so every call failed
  // with "could not determine data type of parameter $1" (a 503 at the
  // route, mislabeled as a generic MT5_BACKEND_ERROR even though this
  // endpoint never touches MT5 at all). Only maxAgeHours is ever bound.
  const result = await pool.query(
    `SELECT DISTINCT ON (r.symbol) r.symbol, r.asset_class, r.decision, r.confidence_pct, r.tradeability_pct, r.profitability_score,
        r.trade_score, r.trade_rating, r.action, r.action_reason
     FROM ai_analysis_runs r
     JOIN watchlists w ON w.symbol = r.symbol AND w.enabled = true
     WHERE r.created_at >= now() - ($1 || ' hours')::interval
       AND r.decision IS NOT NULL
     ORDER BY r.symbol, r.created_at DESC
     LIMIT 200`,
    [maxAgeHours],
  );
  const rows = result.rows.map((row): ScanResultRow => {
    const tradeabilityPct = numOrNull(row.tradeability_pct);
    const tradeability = tradeabilityPct !== null ? deriveTradeability(tradeabilityPct) : null;
    const profitabilityRaw = numOrNull(row.profitability_score);
    const profitability = profitabilityRaw !== null ? deriveProfitability(profitabilityRaw) : null;
    return {
      symbol: row.symbol,
      assetClass: row.asset_class,
      ...technicalStatusForAction(row.action, row.action_reason),
      decision: row.decision,
      action: row.action,
      actionReason: row.action_reason,
      confidencePct: numOrNull(row.confidence_pct),
      tradeabilityPct,
      tradeabilityRating: tradeability?.rating ?? null,
      tradeabilityRatingLabelTh: tradeability?.ratingLabelTh ?? null,
      profitabilityScore: profitability?.profitabilityScore ?? null,
      tradeScore: numOrNull(row.trade_score),
      tradeRating: row.trade_rating,
      tradeRatingLabelTh: row.trade_rating ? TRADE_RATING_LABEL_TH[row.trade_rating as TradeRating] ?? null : null,
      entryType: null,
      pendingOrderType: null,
      currentPrice: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit: null,
      planExpiry: null,
      planId: null,
      riskResult: null,
      riskFailedRules: null,
      riskReward: null,
      maxLoss: null,
      targetProfit: null,
      marginRequired: null,
      freeMargin: null,
      marginShortfall: null,
      aiProvider: null,
      aiModel: null,
      aiPromptVersion: null,
      reasonSummary: null,
      error: null,
      reused: false,
      shadowTradeActive: false,
      shadowTradeStatus: null,
      side: row.decision,
      recommendedVolume: null,
      demoExecutionReady: false,
      blockReasons: [],
      brokerPreflightPass: false,
      executableNow: false,
    };
  });
  return rankByTradeability(rows).slice(0, limit);
}
