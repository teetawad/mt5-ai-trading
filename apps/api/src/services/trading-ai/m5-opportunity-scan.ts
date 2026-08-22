import crypto from 'crypto';
import { Pool } from 'pg';
import { loadFastLearningSettings } from '../../config/fast-learning-settings';
import { loadFinalQualitySettings } from '../../config/final-quality-settings';
import { getMt5Status, listMt5Positions, listMt5PendingOrders } from '../mt5-client';
import { effectiveMt5RiskSettings } from '../../config/mt5-risk-settings';
import { countTradesToday, Mt5Actor } from '../mt5-entry-plan-watcher';
import { analyzeSymbolWithAI, BrokerPreflightInput, PROMPT_VERSION, runBrokerPreflight } from './trading-ai-service';
import { computeM5ShortlistScore } from './shortlist-score';
import { describeTradingAIProvider } from './provider';
import { computeFinalQualityScore, FinalQualityScoreBreakdown, qualityTierFor } from './final-quality-score';
import { applyQualityBasedSizing } from './demo-sizing';
import {
  evaluateAllCandidates,
  findReusablePlanForTimeframe,
  LiveAccountState,
  mapWithConcurrency,
  rankByProfitability,
  ScanResultRow,
  toScanRow,
  toScanRowFromPlanRow,
} from './opportunity-scan';
import { createShadowTradesForCycle } from './shadow-trade-service';
import { classifyAiFailure } from './ai-failure-classification';

// M5 Fast Learning's own scanner (spec sections 1, 2, 17, 18): the
// M5-candle-triggered sibling of opportunity-scan.ts's manual "FIND BEST
// TRADES". Deliberately a separate function rather than a mutation of
// runOpportunityScan, reusing only opportunity-scan.ts's shared Stage A
// helpers (evaluateAllCandidates/mapWithConcurrency/rankByProfitability) —
// the manual scanner's H1-keyed shortlist/reuse-cache behavior and existing
// tests are completely unaffected by this file.
//
// TOP 5 REAL DEMO CANDIDATES (owner spec: "use TOP 5 REAL DEMO candidates
// per completed M5 cycle"): every technically-valid actionable setup still
// becomes a Shadow Trade for fast data collection, but only the strongest
// setups this cycle — final_quality_score >= REAL_DEMO_MIN_FINAL_SCORE,
// Risk-PASS, and broker-validated, ranked by final_quality_score DESC and
// capped at REAL_DEMO_TOP_CANDIDATES — are ever surfaced as REAL DEMO READY.
// Nothing here ever calls order_send/order_check to actually PLACE an
// order; the owner still manually clicks the DEMO execution button for
// whichever of these (if any) they choose.

const STAGE_B_CONCURRENCY = 3;
const SCORING_CONCURRENCY = 4;
const PREFLIGHT_CONCURRENCY = 5;

export interface M5ScanSummary {
  m5CandleTimestamp: string;
  symbolsDiscovered: number;
  dataValid: number;
  aiShortlisted: number;
  actionable: number;
  enterNow: number;
  waitForEntry: number;
  technicalBlocked: number;
  riskPass: number;
  riskBlocked: number;
  openAiRequestsUsed: number;
  reusedFromCache: number;
  shadowTradesCreated: number;
  // TOP 5 REAL DEMO candidates (spec sections 1, 2, 21, 22, 30): never
  // forced up to realDemoTopCandidates — a shorter or zero-length list is
  // reported honestly rather than padded. shadowLearningOnly counts every
  // OTHER actionable row this cycle (below threshold, Risk/broker-blocked,
  // or a qualifying row simply outside the TOP-N capacity).
  realDemoEligible: number;
  shadowLearningOnly: number;
  realDemoMinFinalScore: number;
  realDemoTopCandidates: number;
}

export interface M5OpportunityScanResult {
  scanId: string;
  summary: M5ScanSummary;
  // Alias of realDemoCandidates, kept for backward compatibility with
  // existing callers of this module.
  topOpportunities: ScanResultRow[];
  // At most REAL_DEMO_TOP_CANDIDATES rows: final_quality_score >= threshold,
  // Risk-PASS, broker-validated, ranked by final_quality_score DESC. Safe to
  // present with a "PLACE ... IN MT5 DEMO" button — still requires the
  // owner's manual click (spec section 22: never auto-placed).
  realDemoCandidates: ScanResultRow[];
  // Every other actionable (ENTER_NOW/WAIT_FOR_ENTRY) row this cycle —
  // technically valid and still tracked as a Shadow Trade, just not part of
  // this cycle's REAL DEMO TOP N. Each row's shadowOnlyReason explains why.
  shadowLearningOnly: ScanResultRow[];
  // Every actionable row (realDemoCandidates + shadowLearningOnly),
  // unbounded, ranked by final_quality_score DESC.
  actionable: ScanResultRow[];
}

const ACTIONABLE_ACTIONS = new Set(['ENTER_NOW', 'WAIT_FOR_ENTRY']);

function shadowOnlyReasonFor(row: ScanResultRow, breakdown: FinalQualityScoreBreakdown | null, minScore: number, topCandidates: number): string {
  if (!breakdown) return 'FINAL_QUALITY_SCORE_UNAVAILABLE: missing market data snapshot or entry type for this row.';
  if (breakdown.finalQualityScore < minScore) return `Below REAL DEMO threshold ${minScore}.`;
  if (row.riskResult !== 'PASS') return `Risk Engine blocked: ${(row.riskFailedRules ?? []).join(', ') || row.riskResult || 'REJECT'}`;
  if (!row.brokerPreflightPass) return `Broker validation failed${row.blockReasons.length ? `: ${row.blockReasons.join(', ')}` : '.'}`;
  return `TOP ${topCandidates} REAL DEMO slots already filled by higher-quality setups this cycle.`;
}

export async function runM5OpportunityScan(pool: Pool, actor: Mt5Actor, m5CandleTimestamp: string): Promise<M5OpportunityScanResult> {
  const scanId = crypto.randomUUID();
  const settings = loadFastLearningSettings();
  const scoreSettings = loadFinalQualitySettings();
  const providerInfo = describeTradingAIProvider();

  // Live account state (spec sections 2, 12, 14) — fetched once so the
  // quality-tier resizing and broker preflight below all agree with each
  // other, never a stale snapshot from a prior cycle.
  const [status, positions, pendingOrders, tradesToday] = await Promise.all([
    getMt5Status(actor.requestId ?? undefined),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    countTradesToday(pool),
  ]);
  const liveState: LiveAccountState = { status, positions, pendingOrders, tradesToday };
  const riskSettings = effectiveMt5RiskSettings(status.demo_verified);
  const riskSettingsRecord = riskSettings as unknown as Record<string, unknown>;

  const { evaluated, discovered } = await evaluateAllCandidates(pool, actor);
  const dataValid = evaluated.filter((e) => e.candidate.eligible);
  const packagesBySymbol = new Map(evaluated.filter((e) => e.pkg).map((e) => [e.candidate.symbol, e.pkg!]));

  // M5/M15-weighted shortlist (spec section 2), capped to the M5 cycle's own
  // AI budget (spec section 17) — independent of AI_BEST_TRADES_SHORTLIST_SIZE.
  const shortlisted = dataValid
    .map((entry) => ({ entry, m5Score: entry.pkg ? computeM5ShortlistScore(entry.pkg).score : -1 }))
    .sort((a, b) => b.m5Score - a.m5Score)
    .slice(0, settings.m5_ai_shortlist_size)
    .map((x) => x.entry);

  let openAiRequestsUsed = 0;
  let reusedFromCache = 0;

  const rows = await mapWithConcurrency(shortlisted, STAGE_B_CONCURRENCY, async (entry): Promise<ScanResultRow> => {
    const m5LastClosedTime = entry.pkg?.timeframes.find((tf) => tf.timeframe === 'M5')?.lastClosedTime ?? null;
    try {
      // Deduplicate by symbol + completed M5 candle timestamp (spec section
      // 1) — a symbol whose most recent analysis is on this SAME M5 candle
      // is reused instead of a new OpenAI call, whether that prior analysis
      // came from this cycle's predecessor or a manual scan moments earlier.
      const reusable = await findReusablePlanForTimeframe(pool, entry.candidate.symbol, 'M5', m5LastClosedTime, settings.m5_reuse_max_age_minutes);
      if (reusable) {
        reusedFromCache += 1;
        return toScanRowFromPlanRow(entry.candidate.symbol, entry.candidate.assetClass, reusable);
      }
      openAiRequestsUsed += 1;
      const detail = await analyzeSymbolWithAI(pool, entry.candidate.symbol, actor, {
        triggerSource: 'M5_CYCLE',
        m5CandleTimestamp,
        fallbackPlanExpiryMinutes: settings.m5_plan_expiry_minutes,
      });
      return toScanRow(entry.candidate.symbol, entry.candidate.assetClass, detail, providerInfo);
    } catch (err) {
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
  const riskPassRows = actionable.filter((r) => r.riskResult === 'PASS');

  // Final Quality Score (spec sections 3, 10, 17): computed for every
  // actionable row, not just the ones that might qualify — this is what
  // "rank ALL valid AI plans by final_quality_score DESC" (spec section 17)
  // is ranked by.
  const scored = await mapWithConcurrency(actionable, SCORING_CONCURRENCY, async (row): Promise<{ row: ScanResultRow; breakdown: FinalQualityScoreBreakdown | null }> => {
    const pkg = packagesBySymbol.get(row.symbol);
    if (!pkg || !row.entryType) return { row, breakdown: null };
    const breakdown = await computeFinalQualityScore(pool, {
      profitabilityScore: row.profitabilityScore ?? 0,
      tradeabilityPct: row.tradeabilityPct ?? 0,
      confidencePct: row.confidencePct ?? 0,
      symbol: row.symbol,
      direction: row.side === 'SELL' ? 'SELL' : 'BUY',
      entryType: row.entryType,
      pkg,
    }, scoreSettings);
    row.finalQualityScore = breakdown.finalQualityScore;
    row.multiTimeframeAlignmentScore = breakdown.timeframeAlignment;
    row.historicalPerformanceScore = breakdown.historicalPerformance;
    row.historicalAdjustment = breakdown.historicalAdjustment;
    row.historicalAdjustmentReason = breakdown.historicalAdjustmentReason;
    return { row, breakdown };
  });

  // Rank ALL actionable rows by final_quality_score DESC (spec section 17).
  const rankedAll = [...scored].sort((a, b) => (b.breakdown?.finalQualityScore ?? -1) - (a.breakdown?.finalQualityScore ?? -1));

  // REAL DEMO eligibility gate (spec sections 1-3): score threshold + Risk
  // PASS, BEFORE spending a broker order_check() call — so a shadow-only
  // row never wastes a live broker preflight.
  const qualifying = rankedAll.filter(({ row, breakdown }) => breakdown !== null && breakdown.finalQualityScore >= scoreSettings.real_demo_min_final_score && row.riskResult === 'PASS');

  // STAGE C — broker preflight (mirrors opportunity-scan.ts's "TOP 10
  // EXECUTABLE" fix): only run against candidates that already cleared the
  // score + Risk Engine gates above.
  await mapWithConcurrency(qualifying, PREFLIGHT_CONCURRENCY, async ({ row }): Promise<null> => {
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
    row.executableNow = preflight.brokerPreflightPass && row.demoExecutionReady;
    if (!preflight.brokerPreflightPass && preflight.reason) row.blockReasons.push(preflight.reason);
    return null;
  });

  // TOP N REAL DEMO candidates (spec sections 2, 21, 30, 31): already sorted
  // by final_quality_score DESC via rankedAll -> qualifying's filter order.
  // Never padded up to REAL_DEMO_TOP_CANDIDATES.
  const brokerPass = qualifying.filter(({ row }) => row.brokerPreflightPass);
  const top5 = brokerPass.slice(0, scoreSettings.real_demo_top_candidates);
  const top5PlanIds = new Set(top5.map(({ row }) => row.planId).filter((id): id is string => Boolean(id)));

  // Quality-based DEMO sizing (spec sections 11-14, 32) — applied ONLY to
  // the selected TOP N, since those are the only candidates the owner could
  // actually execute this cycle.
  for (const { row, breakdown } of top5) {
    if (!row.planId || !breakdown) continue;
    const planRowResult = await pool.query('SELECT * FROM ai_trade_plans WHERE id = $1', [row.planId]);
    const planRow = planRowResult.rows[0] as Record<string, unknown> | undefined;
    if (!planRow) continue;
    const sizing = await applyQualityBasedSizing(pool, planRow, breakdown.finalQualityScore, liveState, riskSettingsRecord, scoreSettings, actor.requestId ?? undefined);
    row.riskTier = sizing.tier;
    if (sizing.applied) {
      row.maxLoss = sizing.maxPlannedLoss;
      row.targetProfit = sizing.targetProfit;
      row.recommendedVolume = sizing.recommendedVolume;
    }
  }

  for (const { row, breakdown } of rankedAll) {
    const isTop5 = Boolean(row.planId && top5PlanIds.has(row.planId));
    row.realDemoEligible = isTop5;
    if (!isTop5) {
      row.shadowOnlyReason = shadowOnlyReasonFor(row, breakdown, scoreSettings.real_demo_min_final_score, scoreSettings.real_demo_top_candidates);
      if (row.riskTier === undefined) row.riskTier = breakdown ? qualityTierFor(breakdown.finalQualityScore, scoreSettings).tier : null;
    }
  }

  const realDemoCandidates = top5.map(({ row }) => row);
  const shadowLearningOnly = rankedAll.filter(({ row }) => !row.realDemoEligible).map(({ row }) => row);

  // Dataset persistence (spec sections 21, 23, 25): freeze EVERY actionable
  // row's ranking context, not just the TOP N — later rank comparisons
  // (spec section 25) need the full field, not only the winners.
  if (rankedAll.length) {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rankedAll.forEach(({ row, breakdown }, index) => {
      const rank = index + 1;
      const base = values.length;
      values.push(
        scanId, rank, row.planId, row.symbol, row.assetClass, row.decision, row.action,
        row.profitabilityScore, row.tradeabilityPct, row.confidencePct,
        row.entryPrice, row.stopLoss, row.takeProfit, row.riskReward, row.maxLoss, row.targetProfit,
        row.riskResult, row.aiProvider ?? providerInfo.provider ?? 'unknown', row.aiModel ?? providerInfo.model ?? 'unknown', row.aiPromptVersion ?? PROMPT_VERSION,
        'M5_CYCLE', m5CandleTimestamp,
        breakdown?.timeframeAlignment ?? null, breakdown?.historicalPerformance ?? null, breakdown?.historicalAdjustment ?? 0, breakdown?.historicalAdjustmentReason ?? null,
        breakdown?.finalQualityScore ?? null, row.riskTier ?? null, row.realDemoEligible ?? false, row.shadowOnlyReason ?? null,
      );
      const cols = Array.from({ length: 30 }, (_, i) => `$${base + i + 1}`);
      placeholders.push(`(${cols.join(',')})`);
    });
    await pool.query(
      `INSERT INTO opportunity_scan_results(
         scan_id, rank, ai_trade_plan_id, symbol, asset_class, direction, action,
         profitability_score, tradeability_pct, confidence_pct,
         entry_price, stop_loss, take_profit, risk_reward, max_loss, target_profit,
         risk_result, ai_provider, ai_model, ai_prompt_version, source, m5_candle_timestamp,
         multi_timeframe_alignment_score, historical_performance_score, historical_adjustment, historical_adjustment_reason,
         final_quality_score, risk_tier, real_demo_eligible, shadow_only_reason)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  // Shadow Trading (spec sections 6-9): every actionable row from this cycle
  // gets an automatic, simulated trade — never a real order_send. Reads
  // ai_trade_plans AFTER quality-based sizing above, so a TOP-5 shadow
  // trade's feature snapshot/net-result-estimate reflects the same sizing
  // the owner would actually see if they approved it.
  const shadowResult = await createShadowTradesForCycle(pool, actionable, packagesBySymbol, m5CandleTimestamp);

  const summary: M5ScanSummary = {
    m5CandleTimestamp,
    symbolsDiscovered: discovered,
    dataValid: dataValid.length,
    aiShortlisted: shortlisted.length,
    actionable: actionable.length,
    enterNow: rows.filter((r) => r.action === 'ENTER_NOW').length,
    waitForEntry: rows.filter((r) => r.action === 'WAIT_FOR_ENTRY').length,
    technicalBlocked: rows.filter((r) => r.action === 'NO_EXECUTION' || r.action === null).length,
    riskPass: riskPassRows.length,
    riskBlocked: actionable.filter((r) => r.riskResult !== 'PASS').length,
    openAiRequestsUsed,
    reusedFromCache,
    shadowTradesCreated: shadowResult.created,
    realDemoEligible: realDemoCandidates.length,
    shadowLearningOnly: shadowLearningOnly.length,
    realDemoMinFinalScore: scoreSettings.real_demo_min_final_score,
    realDemoTopCandidates: scoreSettings.real_demo_top_candidates,
  };

  return { scanId, summary, topOpportunities: realDemoCandidates, realDemoCandidates, shadowLearningOnly, actionable: rankedAll.map(({ row }) => row) };
}

// Passive read of the most recent M5-cycle scan's ranking (spec sections 11,
// 18): sorted by final_quality_score descending at persistence time (rank
// column) — serves both "FAST DEMO CANDIDATES" and "FAST FIND BEST TRADES"
// from the same rows. Never triggers a new AI call itself.
export async function getLatestM5Opportunities(pool: Pool): Promise<Record<string, unknown>[]> {
  const latest = await pool.query(`SELECT scan_id FROM opportunity_scan_results WHERE source='M5_CYCLE' ORDER BY created_at DESC LIMIT 1`);
  const scanId = latest.rows[0]?.scan_id as string | undefined;
  if (!scanId) return [];
  const rows = await pool.query(`SELECT * FROM opportunity_scan_results WHERE scan_id = $1 ORDER BY rank ASC`, [scanId]);
  return rows.rows;
}
