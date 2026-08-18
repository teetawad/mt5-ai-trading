import crypto from 'crypto';
import { Pool } from 'pg';
import { getMt5MarketStatus, getMt5SymbolInfo } from '../mt5-client';
import { loadMt5RiskSettings } from '../../config/mt5-risk-settings';
import { loadAiScannerSettings } from '../../config/ai-scanner-settings';
import { Mt5Actor } from '../mt5-entry-plan-watcher';
import { analyzeSymbolWithAI, AiTradePlanDetail, PROMPT_VERSION } from './trading-ai-service';
import { buildMarketAnalysisPackage } from './market-analysis';
import { computeShortlistScore } from './shortlist-score';
import { deriveTradeability } from './tradeability';
import { deriveProfitability } from './profitability';
import { TRADE_RATING_LABEL_TH, TradeRating, tradeRatingFor } from './trade-score';
import { describeTradingAIProvider } from './provider';
import { MarketAnalysisPackage } from './types';

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
// Enough completed bars for the EMA50/RSI14/ATR14/MACD(26+9) math used by
// both the AI's own MarketAnalysisPackage and the shortlist score to be
// meaningful — well below the 220 bars actually fetched per timeframe.
const MIN_BARS_REQUIRED = 60;
const MAX_QUOTE_AGE_SECONDS = 120;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

interface EvaluatedCandidate {
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

async function evaluateAllCandidates(pool: Pool, actor: Mt5Actor): Promise<{ evaluated: EvaluatedCandidate[]; discovered: number }> {
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
  aiProvider: string | null;
  aiModel: string | null;
  aiPromptVersion: string | null;
  reasonSummary: string | null;
  error: string | null;
  // True when this row was served from the recent-analysis reuse cache
  // (spec section 18) instead of a fresh OpenAI call this scan.
  reused: boolean;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toScanRow(symbol: string, assetClass: string, detail: AiTradePlanDetail | { aiConfigured: false; message: string }, providerInfo: { provider: string | null; model: string | null }): ScanResultRow {
  const empty: ScanResultRow = {
    symbol, assetClass, decision: 'ERROR', action: null, actionReason: null, confidencePct: null,
    tradeabilityPct: null, tradeabilityRating: null, tradeabilityRatingLabelTh: null, profitabilityScore: null,
    tradeScore: null, tradeRating: null, tradeRatingLabelTh: null, entryType: null, pendingOrderType: null,
    currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null, planExpiry: null, planId: null,
    riskResult: null, riskFailedRules: null, riskReward: null, maxLoss: null, targetProfit: null,
    aiProvider: providerInfo.provider, aiModel: providerInfo.model, aiPromptVersion: PROMPT_VERSION,
    reasonSummary: null, error: null, reused: false,
  };
  if ('aiConfigured' in detail && detail.aiConfigured === false) {
    return { ...empty, error: detail.message };
  }
  return {
    ...empty,
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
    reasonSummary: detail.explanation.summary,
  };
}

/**
 * Reconstructs a ScanResultRow directly from a previously-persisted
 * ai_trade_plans row (spec section 18 reuse cache) — no AiTradePlanDetail
 * object exists for a reused row (no fresh analyzeSymbolWithAI call was
 * made), so this maps the same DB columns trading-ai-service.ts itself
 * already wrote when that plan was first created.
 */
function toScanRowFromPlanRow(symbol: string, assetClass: string, row: Record<string, unknown>): ScanResultRow {
  const tradeabilityPctRaw = numOrNull(row.tradeability_pct);
  const tradeability = tradeabilityPctRaw !== null ? deriveTradeability(tradeabilityPctRaw) : null;
  const profitabilityRaw = numOrNull(row.profitability_score);
  const profitability = profitabilityRaw !== null ? deriveProfitability(profitabilityRaw) : null;
  const tradeScoreRaw = numOrNull(row.trade_score);
  const tradeRating = row.trade_rating ? (String(row.trade_rating) as TradeRating) : (tradeScoreRaw !== null ? tradeRatingFor(tradeScoreRaw) : null);
  return {
    symbol, assetClass,
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
    aiProvider: strOrNull(row.ai_provider),
    aiModel: strOrNull(row.ai_model),
    aiPromptVersion: strOrNull(row.ai_prompt_version),
    reasonSummary: strOrNull(row.reason_summary),
    error: null,
    reused: true,
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
async function findReusablePlan(pool: Pool, symbol: string, h1LastClosedTime: string | null, maxAgeMinutes: number): Promise<Record<string, unknown> | null> {
  if (!h1LastClosedTime) return null;
  const result = await pool.query(
    `SELECT p.* FROM ai_trade_plans p
     JOIN ai_analysis_runs r ON r.id = p.analysis_run_id
     WHERE p.symbol = $1
       AND p.decision IN ('BUY','SELL')
       AND p.created_at >= now() - ($3 || ' minutes')::interval
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(r.market_analysis_package->'timeframes') elem
         WHERE elem->>'timeframe' = 'H1' AND elem->>'lastClosedTime' = $2
       )
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [symbol, h1LastClosedTime, maxAgeMinutes],
  );
  return result.rows[0] ?? null;
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
  // action=NO_EXECUTION only — genuine technical impossibility (spec
  // section 7/17), never "low tradeability/confidence/profitability".
  technicalBlocked: number;
  // Independent of `action` (spec section 8): a Risk-Engine REJECT can occur
  // on an otherwise-actionable row without changing its action.
  riskPass: number;
  riskBlocked: number;
  // How many of the shortlisted symbols were actually billed to OpenAI this
  // scan (spec section 17/18) — excludes rows served from the reuse cache.
  openAiRequestsUsed: number;
  reusedFromCache: number;
  topOpportunitiesShown: number;
}

export interface OpportunityScanResult {
  scanId: string;
  summary: ScanSummary;
  // "TOP N AI TRADE OPPORTUNITIES" (spec sections 10/11/13/14/16): ranked by
  // profitability_score descending, capped to AiScannerSettings'
  // ai_best_trades_top_count (default 10), and preferring Risk-PASS
  // candidates — see runOpportunityScan. Never fabricated: if fewer than N
  // valid PASS candidates exist, this is simply shorter than N.
  topOpportunities: ScanResultRow[];
  // Every technically valid actionable (ENTER_NOW/WAIT_FOR_ENTRY) row from
  // this scan, unbounded and Risk-PASS/BLOCKED mixed together — a superset
  // of topOpportunities, kept for diagnostics/dataset purposes. The Risk
  // Engine result on each row is authoritative; a BLOCKED row here is never
  // presented as executable (spec section 13: "never pretend they are
  // executable").
  actionable: ScanResultRow[];
  // action=NO_EXECUTION rows — genuine technical impossibility only.
  rejected: ScanResultRow[];
  dataRejected: ScanCandidate[];
}

export async function runOpportunityScan(pool: Pool, actor: Mt5Actor, shortlistSize?: number): Promise<OpportunityScanResult> {
  const scanId = crypto.randomUUID();
  const scannerSettings = loadAiScannerSettings();
  const maxCandidates = shortlistSize ?? scannerSettings.ai_best_trades_shortlist_size;
  const topCount = scannerSettings.ai_best_trades_top_count;
  const providerInfo = describeTradingAIProvider();

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
        return toScanRowFromPlanRow(entry.candidate.symbol, entry.candidate.assetClass, reusable);
      }
      openAiRequestsUsed += 1;
      const detail = await analyzeSymbolWithAI(pool, entry.candidate.symbol, actor);
      return toScanRow(entry.candidate.symbol, entry.candidate.assetClass, detail, providerInfo);
    } catch (err) {
      return {
        symbol: entry.candidate.symbol, assetClass: entry.candidate.assetClass, decision: 'ERROR', action: null, actionReason: null, confidencePct: null,
        tradeabilityPct: null, tradeabilityRating: null, tradeabilityRatingLabelTh: null, profitabilityScore: null,
        tradeScore: null, tradeRating: null, tradeRatingLabelTh: null, entryType: null, pendingOrderType: null,
        currentPrice: null, entryPrice: null, stopLoss: null, takeProfit: null, planExpiry: null, planId: null,
        riskResult: null, riskFailedRules: null, riskReward: null, maxLoss: null, targetProfit: null,
        aiProvider: providerInfo.provider, aiModel: providerInfo.model, aiPromptVersion: PROMPT_VERSION,
        reasonSummary: null, error: (err as Error).message, reused: false,
      };
    }
  });

  const actionable = rankByProfitability(rows.filter((r) => r.action !== null && ACTIONABLE_ACTIONS.has(r.action)));
  const rejected = rows.filter((r) => r.action === 'NO_EXECUTION' || r.action === null);
  const riskPassRows = actionable.filter((r) => r.riskResult === 'PASS');

  // Prefer Risk-PASS candidates for the primary TOP N list (spec section 13:
  // "Prefer TOP 10 candidates with Risk PASS. If there are fewer than 10
  // PASS candidates, show as many valid PASS candidates as exist.") — never
  // padded with Risk-BLOCKED rows, which stay visible only via `actionable`
  // (spec: "never pretend they are executable").
  const topOpportunities = riskPassRows.slice(0, topCount);

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

  const summary: ScanSummary = {
    symbolsDiscovered: discovered,
    dataValid: dataValid.length,
    aiShortlisted: shortlisted.length,
    actionable: actionable.length,
    enterNow: rows.filter((r) => r.action === 'ENTER_NOW').length,
    waitForEntry: rows.filter((r) => r.action === 'WAIT_FOR_ENTRY').length,
    technicalBlocked: rejected.length,
    riskPass: riskPassRows.length,
    riskBlocked: actionable.filter((r) => r.riskResult !== 'PASS').length,
    openAiRequestsUsed,
    reusedFromCache,
    topOpportunitiesShown: topOpportunities.length,
  };

  return { scanId, summary, topOpportunities, actionable, rejected, dataRejected };
}

/**
 * Home page "AI TOP OPPORTUNITIES": a passive read of the most recent
 * persisted analysis per watchlist symbol, ranked by tradeability_pct. Never
 * triggers a new AI call itself (spec section 11).
 */
export async function getTopOpportunities(pool: Pool, limit = 3, maxAgeHours = 12): Promise<ScanResultRow[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (r.symbol) r.symbol, r.asset_class, r.decision, r.confidence_pct, r.tradeability_pct, r.profitability_score,
        r.trade_score, r.trade_rating, r.action, r.action_reason
     FROM ai_analysis_runs r
     JOIN watchlists w ON w.symbol = r.symbol AND w.enabled = true
     WHERE r.created_at >= now() - ($2 || ' hours')::interval
       AND r.decision IS NOT NULL
     ORDER BY r.symbol, r.created_at DESC
     LIMIT 200`,
    [limit, maxAgeHours],
  );
  const rows = result.rows.map((row): ScanResultRow => {
    const tradeabilityPct = numOrNull(row.tradeability_pct);
    const tradeability = tradeabilityPct !== null ? deriveTradeability(tradeabilityPct) : null;
    const profitabilityRaw = numOrNull(row.profitability_score);
    const profitability = profitabilityRaw !== null ? deriveProfitability(profitabilityRaw) : null;
    return {
      symbol: row.symbol,
      assetClass: row.asset_class,
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
      aiProvider: null,
      aiModel: null,
      aiPromptVersion: null,
      reasonSummary: null,
      error: null,
      reused: false,
    };
  });
  return rankByTradeability(rows).slice(0, limit);
}
