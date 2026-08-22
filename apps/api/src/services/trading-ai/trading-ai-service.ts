import crypto from 'crypto';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { createAuditLog } from '../../db/repositories/audit-logs';
import { effectiveMt5RiskSettings, loadMt5RiskSettings } from '../../config/mt5-risk-settings';
import { loadFastLearningSettings } from '../../config/fast-learning-settings';
import {
  cancelMt5PendingOrder,
  checkMt5Order,
  checkMt5PendingOrder,
  getMt5HistoryDeals,
  getMt5HistoryOrders,
  getMt5MarketStatus,
  getMt5Status,
  getMt5SymbolInfo,
  getMt5Tick,
  listMt5PendingOrders,
  listMt5Positions,
  Mt5OrderRequestDTO,
  Mt5PendingOrderRequestDTO,
  sendMt5Order,
  sendMt5PendingOrder,
} from '../mt5-client';
import { TradingEngineError } from '../trading-engine-client';
import { evaluateMt5Risk, normalizeVolume, toRiskSymbolInfo } from '../mt5-risk-engine';
import { checkBrokerStopDistance, roundToDigits } from './broker-price';
import { countTradesToday, Mt5Actor } from '../mt5-entry-plan-watcher';
import { buildMarketAnalysisPackage } from './market-analysis';
import { fetchChartSnapshots } from './charts';
import { getTradingAIProvider } from './provider';
import { computeTradeScore, TradeScoreResult } from './trade-score';
import { deriveTradeability, TradeabilityResult } from './tradeability';
import { deriveProfitability, ProfitabilityResult } from './profitability';
import { AiActionResult, computeAiTradeAction } from './decision-policy';
import { findMt5EvidenceForPlan } from './ai-trade-plan-watcher';
import { planComment } from './plan-comment';
import { AiPlanValidationError, AiProviderNotConfiguredError, AiUnknownSymbolError, TradeAIPlan } from './types';

export const PROMPT_VERSION = 'TRADING_AI_V3_PROMPT_001';

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pendingOrderErrorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The safe diagnostic subset of MT5's MqlTradeResult (spec section 3) —
// never credentials/secrets, MT5's own result never carries any. Persisted
// on every order_send attempt (success or failure) so a case like the
// LTCUSD PENDING_ORDER_NOT_CONFIRMED incident is always diagnosable after
// the fact instead of leaving retcode/order/deal unrecorded.
function safeExecutionSnapshot(source: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!source) return null;
  return {
    retcode: source.retcode ?? null,
    retcode_name: source.retcode_name ?? null,
    order: source.order ?? null,
    deal: source.deal ?? null,
    request_id: source.request_id ?? null,
    comment: source.comment ?? null,
    retcode_external: source.retcode_external ?? null,
    price: source.price ?? null,
    volume: source.volume ?? null,
    bid: source.bid ?? null,
    ask: source.ask ?? null,
    execution_state: source.execution_state ?? null,
    last_error: source.last_error ?? null,
    request: source.request_diagnostics ?? null,
    retcode_is_broker_nonstandard_zero: source.retcode_is_broker_nonstandard_zero ?? false,
  };
}

// Scanner sentinel/placeholder values that must NEVER reach a real MT5
// symbol_info/candle call (spec: "Never send SCAN/ALL/BEST/* or another
// pseudo-symbol into MT5 symbol_info/candle endpoints") — checked before
// ever touching the DB or MT5, not relied on solely via a catalog miss.
const PSEUDO_SYMBOL_PATTERN = /^(SCAN|ALL|BEST|WATCHLIST|\*)$/i;

async function assetClassFor(pool: Pool, symbol: string): Promise<string> {
  if (!symbol || PSEUDO_SYMBOL_PATTERN.test(symbol)) {
    throw new AiUnknownSymbolError(symbol);
  }
  const result = await pool.query('SELECT asset_class FROM instruments WHERE symbol = $1', [symbol]);
  const assetClass = result.rows[0]?.asset_class as string | undefined;
  // Previously defaulted an unrecognized symbol to 'OTHER' and let it fall
  // through to a real MT5 call — the actual root cause of a pseudo-symbol
  // (or any typo) failing deep in the stack with a confusing broker-level
  // "SYMBOL_NOT_FOUND" instead of a clear, immediate rejection here.
  if (assetClass === undefined) throw new AiUnknownSymbolError(symbol);
  return assetClass;
}

function referenceEntryForRisk(plan: TradeAIPlan, bid: number | null, ask: number | null): number | null {
  if (plan.entry_type === 'MARKET_NOW') {
    return plan.decision === 'BUY' ? (ask ?? plan.entry_price) : (bid ?? plan.entry_price);
  }
  if (plan.entry_type === 'PULLBACK') {
    return plan.entry_price ?? (plan.decision === 'BUY' ? plan.entry_zone_high ?? plan.entry_zone_low : plan.entry_zone_low ?? plan.entry_zone_high);
  }
  if (plan.entry_type === 'BREAKOUT') {
    return plan.entry_price ?? plan.trigger_price;
  }
  return null;
}

// order_check() retcodes that mean "the request itself is well-formed and
// affordable" — 10008/10009 are MT5's own "would be placed/done" preview
// codes for a check call that never actually sends anything. Shared by the
// real execution path (placeMarketOrder/placePendingOrder) and the FIND BEST
// TRADES broker preflight (runBrokerPreflight) below, so "would this order
// pass?" always means the exact same thing whether asked before ranking or
// immediately before order_send.
export const ACCEPTED_ORDER_CHECK_RETCODES = [0, 10008, 10009];

export interface BrokerPreflightInput {
  symbol: string;
  decision: 'BUY' | 'SELL';
  entryType: string | null;
  pendingOrderType: string | null;
  referenceEntry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  planExpiry: string | null;
  volume: number | null;
}

export interface BrokerPreflightResult {
  brokerPreflightPass: boolean;
  reason: string | null;
}

/**
 * "TOP 10 EXECUTABLE" broker preflight (FIND BEST TRADES fix, spec section
 * 7): runs the SAME MT5 order_check() this app uses immediately before a
 * real order_send (checkMt5Order for MARKET_NOW, checkMt5PendingOrder for a
 * pending BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP) against the exact request
 * a card's own entry/SL/TP/volume would produce — never a second, weaker
 * heuristic. Never calls order_send/sendMt5PendingOrder — a preview only.
 * Only a candidate whose order_check confidently PASSes (the same
 * ACCEPTED_ORDER_CHECK_RETCODES the real execution path accepts) is safe to
 * present as "READY" — this is what stops a card from looking ready and then
 * failing with PENDING_ORDER_NOT_CONFIRMED/BROKER_NONSTANDARD_RETCODE_ZERO
 * the moment the owner actually clicks it.
 */
export async function runBrokerPreflight(input: BrokerPreflightInput, requestId?: string): Promise<BrokerPreflightResult> {
  if (input.volume === null || !Number.isFinite(input.volume) || input.volume <= 0) {
    return { brokerPreflightPass: false, reason: 'POSITION_SIZE_INVALID' };
  }
  if (input.stopLoss === null || input.takeProfit === null) {
    return { brokerPreflightPass: false, reason: 'MISSING_SL_TP' };
  }
  // Never a real execution_key — this request is never sent to order_send,
  // so uniqueness/idempotency semantics do not apply, only shape validity.
  const preflightKey = `preflight:${crypto.randomUUID()}`;
  try {
    if (input.entryType === 'MARKET_NOW') {
      const check = await checkMt5Order({
        idempotency_key: preflightKey,
        symbol: input.symbol,
        side: input.decision,
        volume: input.volume,
        stop_loss: input.stopLoss,
        take_profit: input.takeProfit,
        deviation: loadMt5RiskSettings().mt5_allowed_deviation_points,
      }, requestId);
      const retcode = Number(check.retcode ?? -1);
      return ACCEPTED_ORDER_CHECK_RETCODES.includes(retcode)
        ? { brokerPreflightPass: true, reason: null }
        : { brokerPreflightPass: false, reason: `MT5_RETCODE_${retcode}` };
    }
    const pendingType = input.pendingOrderType as Mt5PendingOrderRequestDTO['order_type'] | 'NONE' | null;
    if (!pendingType || pendingType === 'NONE') {
      return { brokerPreflightPass: false, reason: 'UNSUPPORTED_ORDER_TYPE' };
    }
    if (input.referenceEntry === null || !Number.isFinite(input.referenceEntry)) {
      return { brokerPreflightPass: false, reason: 'INVALID_PENDING_PRICE' };
    }
    const check = await checkMt5PendingOrder({
      idempotency_key: preflightKey,
      symbol: input.symbol,
      order_type: pendingType,
      price: input.referenceEntry,
      volume: input.volume,
      stop_loss: input.stopLoss,
      take_profit: input.takeProfit,
      expiration: input.planExpiry ? new Date(input.planExpiry).toISOString() : null,
    }, requestId);
    const retcode = Number(check.retcode ?? -1);
    return ACCEPTED_ORDER_CHECK_RETCODES.includes(retcode)
      ? { brokerPreflightPass: true, reason: null }
      : { brokerPreflightPass: false, reason: `MT5_RETCODE_${retcode}` };
  } catch (err) {
    return { brokerPreflightPass: false, reason: `BROKER_PREFLIGHT_UNAVAILABLE: ${(err as Error).message}` };
  }
}

export interface AiTradePlanDetail {
  generatedAt: string;
  symbol: string;
  assetClass: string;
  aiConfigured: true;
  status: Awaited<ReturnType<typeof getMt5Status>>;
  quote: { bid: number | null; ask: number | null; currentPrice: number | null; spread: number | null };
  market: { status: string; dataStatus: string };
  decision: { direction: string; confidencePct: number; trend: string; marketCondition: string };
  // The three-action model (spec: "ALL VALID SETUPS ARE DEMO-ACTIONABLE") —
  // a purely mechanical mapping from entry_type/decision (+ real per-symbol
  // market/data status for ENTER_NOW only), NEVER from tradeability_pct,
  // confidence_pct, Trade Score, or the Risk Engine result. See
  // decision-policy.ts. Risk Engine PASS/BLOCKED is its own independent
  // field below (`risk`), never folded into this action.
  action: AiActionResult;
  // The AI's own, primary quality signal (spec section 1/2) — descriptive
  // only, never an execution gate. See tradeability.ts.
  tradeability: TradeabilityResult;
  // "FIND BEST TRADES" ranking signal (spec sections 6-10) — independent of
  // both confidence and tradeability. See profitability.ts.
  profitability: ProfitabilityResult;
  // Kept only as a secondary, independent dataset-comparison diagnostic
  // (spec section 16: later evaluate which of trade_score/tradeability_pct
  // better predicts real DEMO outcomes) — no longer used for gating.
  tradeScore: TradeScoreResult | null;
  entryPlan: Record<string, unknown>;
  protection: { stopLoss: number | null; takeProfit: number | null; riskReward: number | null };
  positionSizing: Record<string, unknown>;
  risk: Record<string, unknown>;
  explanation: { title: string; summary: string; bullets: string[]; risks: string[] };
  planId: string | null;
  planStatus: string | null;
  charts: Array<{ timeframe: string; mediaType: string }>;
  // Development-only diagnostics (spec: "DEBUG DIAGNOSTICS" — never included
  // outside NODE_ENV=development, never contains API keys or full provider
  // payloads). Lets Advanced Details show exactly what the AI returned for
  // confidence_pct before/after normalization, to verify the conversion.
  debug?: { rawConfidence: unknown; normalizedConfidencePct: number };
}

// Attributes an analysis to whichever cadence produced it (spec section 13,
// 15: "collect every AI decision" and count "M5 decisions today" precisely).
// Defaults preserve every existing call site (manual single-symbol analyze,
// the unmodified runOpportunityScan) exactly as-is.
export interface AnalyzeSymbolOptions {
  triggerSource?: 'MANUAL' | 'M5_CYCLE';
  m5CandleTimestamp?: string;
  // Fallback plan expiry (minutes) used only when the AI's own
  // plan_expiry_minutes is missing/non-finite/non-positive — the AI's
  // judgement is otherwise never overridden (spec section 4).
  fallbackPlanExpiryMinutes?: number;
}

export async function analyzeSymbolWithAI(
  pool: Pool,
  symbol: string,
  actor: Mt5Actor,
  options: AnalyzeSymbolOptions = {},
): Promise<AiTradePlanDetail | { aiConfigured: false; message: string }> {
  const triggerSource = options.triggerSource ?? 'MANUAL';
  const m5CandleTimestamp = options.m5CandleTimestamp ?? null;
  let provider;
  try {
    provider = getTradingAIProvider();
  } catch (err) {
    if (err instanceof AiProviderNotConfiguredError) {
      return { aiConfigured: false, message: err.message };
    }
    throw err;
  }

  const assetClass = await assetClassFor(pool, symbol);
  const startedAt = Date.now();
  const pkg = await buildMarketAnalysisPackage(symbol, assetClass, actor.requestId ?? undefined);
  const charts = await fetchChartSnapshots(symbol, actor.requestId ?? undefined);

  let plan: TradeAIPlan;
  let raw: unknown = null;
  let rawConfidence: unknown = null;
  let validationError: string | null = null;
  let providerError: string | null = null;
  try {
    const result = await provider.analyze({ pkg, charts, promptVersion: PROMPT_VERSION });
    plan = result.plan;
    raw = result.raw;
    rawConfidence = result.rawConfidence;
  } catch (err) {
    if (err instanceof AiPlanValidationError) validationError = `${err.message}: ${err.issues.join('; ')}`;
    else providerError = (err as Error).message;
    await pool.query(
      `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, latency_ms,
        market_analysis_package, chart_refs, raw_ai_response, validation_error, provider_error, trigger_source, m5_candle_timestamp)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        symbol, assetClass, provider.providerName, provider.model, PROMPT_VERSION, Date.now() - startedAt,
        JSON.stringify(pkg), JSON.stringify(charts.map((c) => ({ timeframe: c.timeframe, mediaType: c.mediaType }))),
        null, validationError, providerError, triggerSource, m5CandleTimestamp,
      ],
    );
    throw err;
  }

  // Trade Score is computed here, independently of anything the AI said
  // about itself — see trade-score.ts. Kept only as a secondary,
  // dataset-comparison diagnostic (spec section 16); null for WAIT (no plan
  // to score). tradeability_pct is the AI's own, primary quality signal.
  const tradeScore = computeTradeScore(pkg, plan);
  const tradeability = deriveTradeability(plan.tradeability_pct);
  const profitability = deriveProfitability(plan.profitability_score);

  // A WAIT decision (genuine technical impossibility only — see prompt.ts)
  // never reaches the Risk Engine or a real market/data status check: its
  // action can only ever be NO_EXECUTION (see decision-policy.ts), so it is
  // computed immediately, before the initial log row is even written.
  const waitAction = plan.decision === 'WAIT'
    ? computeAiTradeAction({ decision: 'WAIT', entryType: plan.entry_type, marketStatus: null, dataStatus: null })
    : null;

  const runRow = await pool.query(
    `INSERT INTO ai_analysis_runs(symbol, asset_class, ai_provider, ai_model, ai_prompt_version, latency_ms,
      market_analysis_package, chart_refs, raw_ai_response, decision, confidence_pct, tradeability_pct, profitability_score, trade_score, trade_rating, score_breakdown,
      action, action_reason, trigger_source, m5_candle_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING id`,
    [
      symbol, assetClass, provider.providerName, provider.model, PROMPT_VERSION, Date.now() - startedAt,
      JSON.stringify(pkg), JSON.stringify(charts.map((c) => ({ timeframe: c.timeframe, mediaType: c.mediaType }))),
      JSON.stringify(raw), plan.decision, plan.confidence_pct, tradeability.tradeabilityPct, profitability.profitabilityScore,
      tradeScore?.tradeScore ?? null, tradeScore?.tradeRating ?? null, tradeScore ? JSON.stringify(tradeScore.breakdown) : null,
      waitAction?.action ?? null, waitAction?.reason ?? null, triggerSource, m5CandleTimestamp,
    ],
  );
  const analysisRunId = runRow.rows[0].id as string;

  await createAuditLog(pool, {
    eventType: 'AI_TRADE_ANALYSIS_RUN',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_analysis_run',
    entityId: analysisRunId,
    action: 'ANALYZE_WITH_AI',
    afterData: { symbol, decision: plan.decision, confidence_pct: plan.confidence_pct, tradeability_pct: tradeability.tradeabilityPct },
    requestId: actor.requestId ?? null,
  });

  const status = await getMt5Status(actor.requestId ?? undefined);

  if (plan.decision === 'WAIT') {
    return waitDetail(symbol, assetClass, status, pkg, plan, charts, rawConfidence, waitAction as AiActionResult, tradeability, profitability);
  }
  // decision is BUY/SELL here, so computeTradeScore always returned a result.
  const score = tradeScore as TradeScoreResult;

  const [symbolInfoRaw, positions, pendingOrders, symbolMarketStatus] = await Promise.all([
    getMt5SymbolInfo(symbol, actor.requestId ?? undefined).catch(() => null),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    // The real per-symbol session/data status (distinct from status.connected
    // used below for the Risk Engine's own, unchanged inputs) — needed only
    // for the decision policy's ENTER_NOW "market OPEN"/"LIVE quote" gate.
    getMt5MarketStatus(symbol, actor.requestId ?? undefined).catch(() => null),
  ]);
  const cfg = effectiveMt5RiskSettings(status.demo_verified) as unknown as Record<string, unknown>;
  const tradesToday = await countTradesToday(pool);
  const referenceEntry = referenceEntryForRisk(plan, pkg.quote.bid, pkg.quote.ask);

  const risk = evaluateMt5Risk({
    decision: plan.decision,
    referenceEntry: String(referenceEntry ?? 0),
    stopLoss: plan.stop_loss !== null ? String(plan.stop_loss) : null,
    takeProfit: plan.take_profit !== null ? String(plan.take_profit) : null,
    riskReward: plan.risk_reward !== null ? String(plan.risk_reward) : null,
    confidence: plan.confidence_pct,
    account: status.account,
    terminal: status.terminal,
    settings: cfg,
    openPositions: positions.length,
    tradesToday,
    quoteAgeSeconds: pkg.quote.quoteAgeSeconds ?? undefined,
    marketStatus: status.connected ? 'OPEN' : 'UNKNOWN',
    dataStatus: status.demo_verified ? 'LIVE' : 'DISCONNECTED',
    symbol: toRiskSymbolInfo(symbolInfoRaw),
    leverage: Number(status.account?.leverage) || null,
  });

  const duplicateSymbol = positions.some((p) => String(p.symbol) === symbol) || pendingOrders.some((o) => String(o.symbol) === symbol);
  const brokerStop = referenceEntry !== null && plan.stop_loss !== null && plan.take_profit !== null
    ? checkBrokerStopDistance({
        referenceEntry, currentPrice: plan.current_price, stopLoss: plan.stop_loss, takeProfit: plan.take_profit,
        entryType: plan.entry_type as 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT',
        point: numberOrNull(symbolInfoRaw?.point), stopsLevelPoints: numberOrNull(symbolInfoRaw?.trade_stops_level),
      })
    : { ok: true, reason: null };
  const failedRules = [
    ...risk.failedRules,
    ...(duplicateSymbol ? ['POSITION_EXISTS'] : []),
    ...(brokerStop.ok ? [] : [brokerStop.reason as string]),
  ];
  const riskResult: 'PASS' | 'REJECT' = failedRules.length ? 'REJECT' : 'PASS';

  const action = computeAiTradeAction({
    decision: plan.decision,
    entryType: plan.entry_type,
    marketStatus: (symbolMarketStatus?.market_status as 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN' | undefined) ?? null,
    dataStatus: (symbolMarketStatus?.data_status as 'LIVE' | 'STALE' | 'DISCONNECTED' | undefined) ?? null,
  });
  await pool.query('UPDATE ai_analysis_runs SET action=$2, action_reason=$3 WHERE id=$1', [analysisRunId, action.action, action.reason]);

  const planExpiryMinutes = Number.isFinite(plan.plan_expiry_minutes) && plan.plan_expiry_minutes > 0
    ? plan.plan_expiry_minutes
    : (options.fallbackPlanExpiryMinutes ?? plan.plan_expiry_minutes);
  const planExpiry = new Date(Date.now() + planExpiryMinutes * 60_000).toISOString();
  const status0 = riskResult === 'PASS' ? 'WAITING_FOR_APPROVAL' : 'RISK_BLOCKED';

  const saved = await pool.query(
    `INSERT INTO ai_trade_plans(
        analysis_run_id, symbol, asset_class, ai_provider, ai_model, ai_prompt_version,
        decision, confidence_pct, tradeability_pct, tradeability_rating, profitability_score, trade_score, trade_rating, score_breakdown, trend,
        entry_type, current_price, entry_price, entry_zone_low, entry_zone_high, trigger_price, pending_order_type,
        stop_loss, take_profit, risk_reward,
        recommended_volume, max_planned_loss, target_profit,
        expected_holding_minutes, plan_expiry, invalidation_reason, reason_summary, reason_details, risks,
        risk_result, risk_failed_rules, risk_snapshot, status, blocked_reason, action, action_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
      RETURNING *`,
    [
      analysisRunId, symbol, assetClass, provider.providerName, provider.model, PROMPT_VERSION,
      plan.decision, plan.confidence_pct, tradeability.tradeabilityPct, tradeability.rating, profitability.profitabilityScore, score.tradeScore, score.tradeRating, JSON.stringify(score.breakdown), plan.trend,
      plan.entry_type, plan.current_price, plan.entry_price, plan.entry_zone_low, plan.entry_zone_high, plan.trigger_price, plan.pending_order_type,
      plan.stop_loss, plan.take_profit, plan.risk_reward,
      risk.recommendedVolume, risk.riskAmount, targetProfitOf(risk.riskAmount, plan.risk_reward),
      plan.expected_holding_minutes, planExpiry, plan.invalidation_reason, plan.reason_summary, JSON.stringify(plan.reason_details), JSON.stringify(plan.risks),
      riskResult, JSON.stringify(failedRules), JSON.stringify(risk.snapshot), status0,
      riskResult === 'REJECT' ? (failedRules[0] ?? 'RISK_LIMIT') : null,
      action.action, action.reason,
    ],
  );
  const row = saved.rows[0] as Record<string, unknown>;

  return buildDetail(symbol, assetClass, status, pkg, plan, score, risk, failedRules, riskResult, row, charts, rawConfidence, action, tradeability, profitability);
}

function targetProfitOf(riskAmount: string, riskReward: number | null): string | null {
  const risk = Number(riskAmount);
  if (!Number.isFinite(risk) || riskReward === null) return null;
  return (risk * riskReward).toFixed(8);
}

function debugConfidence(rawConfidence: unknown, normalized: number): { rawConfidence: unknown; normalizedConfidencePct: number } | undefined {
  return process.env.NODE_ENV === 'development' ? { rawConfidence, normalizedConfidencePct: normalized } : undefined;
}

function waitDetail(
  symbol: string,
  assetClass: string,
  status: Awaited<ReturnType<typeof getMt5Status>>,
  pkg: Awaited<ReturnType<typeof buildMarketAnalysisPackage>>,
  plan: TradeAIPlan,
  charts: Array<{ timeframe: string; mediaType: string }>,
  rawConfidence: unknown,
  action: AiActionResult,
  tradeability: TradeabilityResult,
  profitability: ProfitabilityResult,
): AiTradePlanDetail {
  return {
    generatedAt: new Date().toISOString(),
    symbol,
    assetClass,
    aiConfigured: true,
    status,
    quote: { bid: pkg.quote.bid, ask: pkg.quote.ask, currentPrice: pkg.quote.ask ?? pkg.quote.bid, spread: pkg.quote.spread },
    market: pkg.market,
    // A WAIT decision can carry a fully meaningful confidence_pct (e.g. 88 =
    // "88% sure no good entry exists right now") — never forced to 0/100.
    decision: { direction: 'WAIT', confidencePct: plan.confidence_pct, trend: plan.trend, marketCondition: plan.market_condition },
    action,
    tradeability,
    profitability,
    tradeScore: null,
    entryPlan: { entry_type: 'NO_ENTRY', pending_order_type: 'NONE' },
    protection: { stopLoss: null, takeProfit: null, riskReward: null },
    positionSizing: {},
    risk: { result: null, label: 'NO TRADE SETUP' },
    explanation: {
      // NO_EXECUTION here is reserved for genuine technical impossibility
      // only (see decision-policy.ts/prompt.ts) — never "low quality".
      title: 'No trade setup — insufficient data',
      summary: plan.reason_summary,
      bullets: plan.reason_details,
      risks: plan.risks,
    },
    planId: null,
    planStatus: null,
    charts: charts.map((c) => ({ timeframe: c.timeframe, mediaType: c.mediaType })),
    debug: debugConfidence(rawConfidence, plan.confidence_pct),
  };
}

function buildDetail(
  symbol: string,
  assetClass: string,
  status: Awaited<ReturnType<typeof getMt5Status>>,
  pkg: Awaited<ReturnType<typeof buildMarketAnalysisPackage>>,
  plan: TradeAIPlan,
  score: TradeScoreResult,
  risk: ReturnType<typeof evaluateMt5Risk>,
  failedRules: string[],
  riskResult: 'PASS' | 'REJECT',
  row: Record<string, unknown>,
  charts: Array<{ timeframe: string; mediaType: string }>,
  rawConfidence: unknown,
  action: AiActionResult,
  tradeability: TradeabilityResult,
  profitability: ProfitabilityResult,
): AiTradePlanDetail {
  return {
    generatedAt: new Date().toISOString(),
    symbol,
    assetClass,
    aiConfigured: true,
    status,
    quote: { bid: pkg.quote.bid, ask: pkg.quote.ask, currentPrice: plan.decision === 'BUY' ? (pkg.quote.ask ?? pkg.quote.bid) : (pkg.quote.bid ?? pkg.quote.ask), spread: pkg.quote.spread },
    market: pkg.market,
    decision: { direction: plan.decision, confidencePct: plan.confidence_pct, trend: plan.trend, marketCondition: plan.market_condition },
    action,
    tradeability,
    profitability,
    tradeScore: score,
    entryPlan: {
      id: row.id,
      entry_type: plan.entry_type,
      entry_price: plan.entry_price,
      entry_zone_low: plan.entry_zone_low,
      entry_zone_high: plan.entry_zone_high,
      trigger_price: plan.trigger_price,
      pending_order_type: plan.pending_order_type,
      plan_expiry: row.plan_expiry,
      status: row.status,
    },
    protection: { stopLoss: plan.stop_loss, takeProfit: plan.take_profit, riskReward: plan.risk_reward },
    positionSizing: {
      recommendedLotSize: risk.recommendedVolume,
      maximumPlannedLoss: risk.riskAmount,
      targetProfit: targetProfitOf(risk.riskAmount, plan.risk_reward),
      source: 'SERVER_SIDE_RISK_ENGINE',
    },
    risk: {
      result: riskResult,
      label: riskResult === 'PASS' ? 'RISK CHECK: PASS' : 'TRADE BLOCKED',
      failedRules,
      snapshot: risk.snapshot,
    },
    explanation: {
      title: `AI recommends ${plan.decision}`,
      summary: plan.reason_summary,
      bullets: plan.reason_details,
      risks: plan.risks,
    },
    planId: String(row.id),
    planStatus: String(row.status),
    charts: charts.map((c) => ({ timeframe: c.timeframe, mediaType: c.mediaType })),
    debug: debugConfidence(rawConfidence, plan.confidence_pct),
  };
}

// ---------------------------------------------------------------------------
// Owner approval -> real MT5 execution. Mirrors the same discipline as
// mt5-entry-plan-watcher.ts's claim+execute engine: everything is re-checked
// fresh immediately before ever calling order_check/order_send, never trusted
// from the plan row alone.
// ---------------------------------------------------------------------------

export interface AiPlanExecutionOutcome {
  allowed: boolean;
  code: string | null;
  reason?: string;
  plan: Record<string, unknown> | null;
}

async function claimPlanForApproval(pool: Pool, planId: string): Promise<Record<string, unknown> | null> {
  const key = `ai-plan:${planId}:${Date.now()}`;
  const result = await pool.query(
    `UPDATE ai_trade_plans SET status='PENDING_ORDER_SUBMITTING', submitting_at=now(), execution_key=$2, updated_at=now()
     WHERE id=$1 AND status='WAITING_FOR_APPROVAL' AND execution_key IS NULL
     RETURNING *`,
    [planId, key],
  );
  return result.rows[0] ?? null;
}

async function blockPlan(
  pool: Pool,
  plan: Record<string, unknown>,
  // ORDER_CANCELLED is a distinct, real terminal state (spec section 7/8):
  // MT5 order/deal HISTORY proved the broker itself cancelled/rejected/
  // expired the order — never the same bucket as EXECUTION_FAILED, which
  // implies "something went wrong on our side" rather than "MT5 gave a
  // definite negative answer".
  status: 'RISK_BLOCKED' | 'EXECUTION_FAILED' | 'ORDER_CANCELLED',
  reason: string,
  // Optional fuller, human-readable detail for the outward-facing outcome
  // (e.g. the trading engine's own descriptive message, which may include
  // retcode/broker context) — `reason` itself stays a short code, matching
  // every other call site in this file, and is what's persisted as
  // blocked_reason for consistent audit/classification.
  outcomeMessage: string = reason,
  snapshot: Record<string, unknown> | null = null,
): Promise<AiPlanExecutionOutcome> {
  await pool.query(
    `UPDATE ai_trade_plans
     SET status=$2, blocked_reason=$3, execution_key=NULL, updated_at=now(),
         cancelled_at = CASE WHEN $2 = 'ORDER_CANCELLED' THEN now() ELSE cancelled_at END,
         execution_snapshot = COALESCE($4::jsonb, execution_snapshot)
     WHERE id=$1 AND status NOT IN ('POSITION_OPEN','POSITION_CLOSED','PLAN_EXPIRED','ORDER_CANCELLED')`,
    [plan.id, status, reason, snapshot ? JSON.stringify(snapshot) : null],
  );
  // The diagnostics snapshot must reach the caller (and the frontend) on
  // this same response, not only the DB row — otherwise the owner sees
  // "not confirmed" with no retcode/order/deal/request_id to act on, which
  // is exactly the gap that left a prior GBPUSD/LTCUSD row undiagnosable.
  return {
    allowed: false,
    code: status,
    reason: outcomeMessage,
    plan: { ...plan, status, blocked_reason: reason, ...(snapshot ? { execution_snapshot: snapshot } : {}) },
  };
}

/**
 * Duplicate-submission protection (spec section 8): if this plan is already
 * mid-flight (PENDING_ORDER_SUBMITTING — e.g. a prior /approve call is still
 * in progress, or its response never made it back before a retry), NEVER
 * fire a second order_send for it. Instead check MT5 immediately for
 * evidence the earlier attempt already succeeded (same execution-key
 * comment, per findMt5EvidenceForPlan — the exact lookup the watcher itself
 * uses, just without waiting out its grace period) and, if found, report
 * ALREADY_PLACED with the real ticket instead of a bare "cannot approve".
 */
async function checkAlreadyPlacedOnConflict(pool: Pool, row: Record<string, unknown>, actor: Mt5Actor): Promise<AiPlanExecutionOutcome | null> {
  if (row.status !== 'PENDING_ORDER_SUBMITTING') return null;

  const [pendingOrders, positions] = await Promise.all([
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
  ]);
  const { matchedOrder, matchedPosition } = findMt5EvidenceForPlan(row, pendingOrders, positions);

  if (matchedOrder) {
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='PENDING_ORDER_PLACED', placed_at=now(), mt5_order_ticket=$2, execution_key=NULL, updated_at=now()
       WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING' RETURNING *`,
      [row.id, String(matchedOrder.ticket ?? '')],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'This plan already placed a real MT5 pending order.', plan: updated.rows[0] ?? { ...row, status: 'PENDING_ORDER_PLACED', mt5_order_ticket: matchedOrder.ticket } };
  }
  if (matchedPosition) {
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', actual_entry=$2, mt5_position_ticket=$3, execution_key=NULL, updated_at=now()
       WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING' RETURNING *`,
      [row.id, numberOrNull(matchedPosition.price_open) ?? row.entry_price, String(matchedPosition.ticket ?? '')],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'This plan already opened a real MT5 position.', plan: updated.rows[0] ?? { ...row, status: 'POSITION_OPEN', mt5_position_ticket: matchedPosition.ticket } };
  }
  return null;
}

// Order/deal HISTORY states that prove the broker already filled a
// PENDING_ORDER_NOT_CONFIRMED/AMBIGUOUS plan's execution — the real MT5
// ORDER_STATE_FILLED constant is 4 (see mt5/adapter.py's own use of the
// same value, sourced directly from the MetaTrader5 package).
const MT5_ORDER_STATE_FILLED = 4;
const MT5_DEAL_ENTRY_IN = 0;

/**
 * "NO BLIND RETRY" (spec section 8, marked CRITICAL): before an owner's
 * retry of a plan that previously ended EXECUTION_FAILED with a genuinely
 * inconclusive outcome (PENDING_ORDER_NOT_CONFIRMED or
 * PENDING_ORDER_CONFIRMATION_AMBIGUOUS — never a definite rejection, which
 * needs no re-check) is ever allowed to call order_send again, this
 * reconciles across every MT5 source by the plan's own execution-key
 * comment (planComment(row.id) is deterministic per plan id, so this still
 * works even though execution_key itself was already cleared). If evidence
 * is found anywhere, the plan is updated to its real state and returned as
 * ALREADY_PLACED — never a second order_send. Only when truly nothing is
 * found anywhere is the plan released back to WAITING_FOR_APPROVAL for a
 * brand-new attempt with a fresh execution_key — and only for
 * PENDING_ORDER_NOT_CONFIRMED, never for AMBIGUOUS (where multiple real MT5
 * objects may already exist and a third attempt must never be risked
 * without manual review).
 */
async function reconcileInconclusiveExecution(pool: Pool, row: Record<string, unknown>, actor: Mt5Actor): Promise<AiPlanExecutionOutcome | null> {
  if (row.status !== 'EXECUTION_FAILED') return null;
  const reason = String(row.blocked_reason ?? '');
  if (reason !== 'PENDING_ORDER_NOT_CONFIRMED' && reason !== 'PENDING_ORDER_CONFIRMATION_AMBIGUOUS') return null;

  const symbol = String(row.symbol);
  const [pendingOrders, positions, historyOrders, historyDeals] = await Promise.all([
    listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    getMt5HistoryOrders(symbol, 24, actor.requestId ?? undefined).catch(() => []),
    getMt5HistoryDeals(symbol, 24, actor.requestId ?? undefined).catch(() => []),
  ]);

  const { matchedOrder, matchedPosition } = findMt5EvidenceForPlan(row, pendingOrders, positions);
  if (matchedOrder) {
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='PENDING_ORDER_PLACED', placed_at=now(), mt5_order_ticket=$2, blocked_reason=NULL, execution_key=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, String(matchedOrder.ticket ?? '')],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'MT5 reconciliation found this plan already placed a real pending order.', plan: updated.rows[0] ?? row };
  }
  if (matchedPosition) {
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_position_ticket=$3, blocked_reason=NULL, execution_key=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, numberOrNull(matchedPosition.price_open) ?? row.entry_price, String(matchedPosition.ticket ?? '')],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'MT5 reconciliation found this plan already opened a real position.', plan: updated.rows[0] ?? row };
  }

  const comment = planComment(row.id);
  const matchedHistoryOrder = historyOrders.find((o) => String(o.symbol) === symbol && String(o.comment ?? '') === comment);
  if (matchedHistoryOrder && Number(matchedHistoryOrder.state) === MT5_ORDER_STATE_FILLED) {
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_order_ticket=$3, blocked_reason=NULL, execution_key=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, numberOrNull(matchedHistoryOrder.price_open) ?? row.entry_price, String(matchedHistoryOrder.ticket ?? '')],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'MT5 order history proved this plan already filled.', plan: updated.rows[0] ?? row };
  }
  const matchedHistoryDeal = historyDeals.find((d) => String(d.symbol) === symbol && String(d.comment ?? '') === comment && Number(d.entry) === MT5_DEAL_ENTRY_IN);
  if (matchedHistoryDeal) {
    const positionTicket = matchedHistoryDeal.position_id ?? matchedHistoryDeal.order ?? null;
    const updated = await pool.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_position_ticket=$3, blocked_reason=NULL, execution_key=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, numberOrNull(matchedHistoryDeal.price) ?? row.entry_price, positionTicket !== null ? String(positionTicket) : null],
    );
    return { allowed: true, code: 'ALREADY_PLACED', reason: 'MT5 deal history proved this plan already filled.', plan: updated.rows[0] ?? row };
  }

  // Genuinely nothing anywhere: only PENDING_ORDER_NOT_CONFIRMED (never
  // AMBIGUOUS) is safe to release for a brand-new attempt — with a fresh
  // execution_key, minted the next time this plan is claimed (spec section
  // 8: "Only a brand new valid AI plan/execution key may create another
  // order").
  if (reason === 'PENDING_ORDER_NOT_CONFIRMED') {
    await pool.query(
      `UPDATE ai_trade_plans SET status='WAITING_FOR_APPROVAL', blocked_reason=NULL, submitting_at=NULL, execution_key=NULL, updated_at=now() WHERE id=$1 AND status='EXECUTION_FAILED'`,
      [row.id],
    );
  }
  return null;
}

export async function approveAndPlaceAiTradePlan(pool: Pool, planId: string, actor: Mt5Actor): Promise<AiPlanExecutionOutcome> {
  let claimed = await claimPlanForApproval(pool, planId);
  if (!claimed) {
    const current = await pool.query('SELECT * FROM ai_trade_plans WHERE id=$1', [planId]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { allowed: false, code: 'PLAN_NOT_FOUND', reason: 'AI trade plan not found', plan: null };
    const alreadyPlaced = await checkAlreadyPlacedOnConflict(pool, row, actor);
    if (alreadyPlaced) return alreadyPlaced;

    const reconciled = await reconcileInconclusiveExecution(pool, row, actor);
    if (reconciled) return reconciled;

    // reconcileInconclusiveExecution only ever resets the plan back to
    // WAITING_FOR_APPROVAL when it found truly no evidence anywhere — try
    // claiming it once more so this single approve click can proceed
    // immediately with a brand-new execution_key, instead of making the
    // owner click again.
    claimed = await claimPlanForApproval(pool, planId);
    if (!claimed) {
      const refreshed = await pool.query('SELECT * FROM ai_trade_plans WHERE id=$1', [planId]);
      const refreshedRow = (refreshed.rows[0] as Record<string, unknown> | undefined) ?? row;
      return { allowed: false, code: `NOT_CLAIMABLE_${refreshedRow.status}`, reason: `Plan is ${refreshedRow.status}; it cannot be approved from this state.`, plan: refreshedRow };
    }
  }

  try {
    const riskSettings = loadMt5RiskSettings();
    if (new Date(String(claimed.plan_expiry)).getTime() <= Date.now()) {
      await pool.query(`UPDATE ai_trade_plans SET status='PLAN_EXPIRED', expired_at=now(), execution_key=NULL, updated_at=now() WHERE id=$1`, [planId]);
      return { allowed: false, code: 'PLAN_EXPIRED', reason: 'The AI plan expired before it could be approved', plan: { ...claimed, status: 'PLAN_EXPIRED' } };
    }
    if (riskSettings.mt5_kill_switch_enabled === true) {
      return await blockPlan(pool, claimed, 'RISK_BLOCKED', 'KILL_SWITCH');
    }

    const status = await getMt5Status(actor.requestId ?? undefined).catch(() => null);
    if (!status || !status.demo_verified) {
      return await blockPlan(pool, claimed, 'RISK_BLOCKED', status?.blocked_reason ?? 'DEMO_VERIFICATION_FAILED');
    }
    // demo_verified is confirmed true above — a no-op here, kept for the
    // same defense-in-depth guarantee as every other evaluateMt5Risk call
    // site (effectiveMt5RiskSettings never applies the loosened Fast
    // Learning DEMO profile without a verified DEMO account).
    const cfg = effectiveMt5RiskSettings(status.demo_verified, riskSettings) as unknown as Record<string, unknown>;

    const symbol = String(claimed.symbol);

    // Spec section 12: "one active real DEMO plan/order per symbol" — this
    // is distinct from the live-MT5 POSITION_EXISTS/PENDING_ORDER checks
    // below (which only see what MT5 already confirmed): a second local
    // ai_trade_plans row for the same symbol can be mid-flight toward MT5
    // (PENDING_ORDER_SUBMITTING) without a broker-side position/order
    // existing yet, which those checks alone would miss.
    if (loadFastLearningSettings().mt5_one_active_plan_per_symbol) {
      const activeOther = await pool.query(
        `SELECT id FROM ai_trade_plans
         WHERE symbol = $1 AND id != $2
           AND status IN ('PENDING_ORDER_SUBMITTING','PENDING_ORDER_PLACED','PENDING_ORDER_TRIGGERED','POSITION_OPEN')
         LIMIT 1`,
        [symbol, planId],
      );
      if (activeOther.rows.length) {
        return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'ANOTHER_PLAN_ACTIVE_FOR_SYMBOL');
      }
    }

    const side = String(claimed.decision) as 'BUY' | 'SELL';
    const [tick, market, symbolInfo, positions, pendingOrders] = await Promise.all([
      getMt5Tick(symbol, actor.requestId ?? undefined).catch(() => null),
      getMt5MarketStatus(symbol, actor.requestId ?? undefined).catch(() => null),
      getMt5SymbolInfo(symbol, actor.requestId ?? undefined).catch(() => null),
      listMt5Positions(actor.requestId ?? undefined).catch(() => []),
      listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
    ]);
    if (!tick || !market) return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'STALE_DATA');
    if (market.market_status !== 'OPEN') return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'MARKET_CLOSED');
    if (market.data_status !== 'LIVE') return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'STALE_DATA');
    if (positions.some((p) => String(p.symbol) === symbol)) return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'POSITION_EXISTS');
    if (pendingOrders.some((o) => String(o.symbol) === symbol)) return await blockPlan(pool, claimed, 'EXECUTION_FAILED', 'PENDING_ORDER');

    const tradesToday = await countTradesToday(pool);
    const bid = numberOrNull(tick.bid);
    const ask = numberOrNull(tick.ask);
    const entryType = String(claimed.entry_type);
    const referenceEntry = entryType === 'MARKET_NOW' ? (side === 'BUY' ? ask : bid) : Number(claimed.entry_price ?? claimed.trigger_price ?? claimed.entry_zone_low);

    const risk = evaluateMt5Risk({
      decision: side,
      referenceEntry: String(referenceEntry ?? 0),
      stopLoss: claimed.stop_loss !== null ? String(claimed.stop_loss) : null,
      takeProfit: claimed.take_profit !== null ? String(claimed.take_profit) : null,
      riskReward: claimed.risk_reward !== null ? String(claimed.risk_reward) : null,
      confidence: Number(claimed.confidence_pct ?? 0),
      account: status.account,
      terminal: status.terminal,
      settings: cfg,
      openPositions: positions.length,
      tradesToday,
      marketStatus: market.market_status as 'OPEN',
      dataStatus: market.data_status as 'LIVE',
      symbol: toRiskSymbolInfo(symbolInfo),
      leverage: Number(status.account?.leverage) || null,
    });
    if (risk.result !== 'PASS') return await blockPlan(pool, claimed, 'RISK_BLOCKED', risk.failedRules[0] ?? 'RISK_LIMIT');

    // Broker-aware re-check immediately before execution (spec: "BROKER-AWARE
    // MT5 VALIDATION") — uses the real live tick, not the AI's own
    // current_price snapshot from analysis time, since price may have moved
    // since the plan was created. Never silently repairs a materially
    // invalid stop/entry distance; only the Risk Engine result and this
    // explicit block reason decide the outcome.
    if (referenceEntry !== null && claimed.stop_loss !== null && claimed.take_profit !== null) {
      const brokerStop = checkBrokerStopDistance({
        referenceEntry,
        currentPrice: side === 'BUY' ? ask : bid,
        stopLoss: Number(claimed.stop_loss),
        takeProfit: Number(claimed.take_profit),
        entryType: entryType as 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT',
        point: numberOrNull(symbolInfo?.point),
        stopsLevelPoints: numberOrNull(symbolInfo?.trade_stops_level),
      });
      if (!brokerStop.ok) return await blockPlan(pool, claimed, 'RISK_BLOCKED', brokerStop.reason ?? 'BROKER_STOP_DISTANCE');
    }

    const bounds = {
      min: new Decimal(numberOrNull(symbolInfo?.volume_min) ?? 0.01),
      max: new Decimal(numberOrNull(symbolInfo?.volume_max) ?? 100),
      step: new Decimal(numberOrNull(symbolInfo?.volume_step) ?? 0.01),
    };
    const finalVolume = normalizeVolume(new Decimal(risk.recommendedVolume), bounds.min, bounds.max, bounds.step);
    if (finalVolume.lte(0)) return await blockPlan(pool, claimed, 'RISK_BLOCKED', 'POSITION_SIZE_INVALID');

    await pool.query('UPDATE ai_trade_plans SET final_volume=$2, updated_at=now() WHERE id=$1', [planId, finalVolume.toFixed(8)]);

    // Minor broker-digits precision normalization only (never a materially
    // different price) — MT5 rejects requests with more decimal places than
    // the symbol's own `digits`. The stored plan itself is left untouched;
    // only the values actually sent over the wire are rounded.
    const digits = numberOrNull(symbolInfo?.digits);
    const roundedPlan = {
      ...claimed,
      stop_loss: claimed.stop_loss !== null ? roundToDigits(Number(claimed.stop_loss), digits) : null,
      take_profit: claimed.take_profit !== null ? roundToDigits(Number(claimed.take_profit), digits) : null,
    };
    if (entryType === 'MARKET_NOW') {
      return await placeMarketOrder(pool, roundedPlan, actor, Number(finalVolume), side, status.account);
    }
    const roundedReferenceEntry = referenceEntry !== null ? roundToDigits(referenceEntry, digits) : null;
    return await placePendingOrder(pool, roundedPlan, actor, Number(finalVolume), side, roundedReferenceEntry);
  } catch (err) {
    await pool.query(
      `UPDATE ai_trade_plans SET status='EXECUTION_FAILED', blocked_reason=$2, execution_key=NULL, updated_at=now() WHERE id=$1`,
      [planId, 'UNEXPECTED_ERROR'],
    );
    throw err;
  }
}

async function placeMarketOrder(pool: Pool, plan: Record<string, unknown>, actor: Mt5Actor, volume: number, side: 'BUY' | 'SELL', account: Record<string, unknown> | null | undefined): Promise<AiPlanExecutionOutcome> {
  const cfg = loadMt5RiskSettings();
  const request: Mt5OrderRequestDTO = {
    idempotency_key: String(plan.execution_key),
    symbol: String(plan.symbol),
    side,
    volume,
    stop_loss: Number(plan.stop_loss),
    take_profit: Number(plan.take_profit),
    deviation: cfg.mt5_allowed_deviation_points,
    comment: planComment(plan.id),
  };
  let check: Record<string, unknown>;
  try {
    check = await checkMt5Order(request, actor.requestId ?? undefined);
  } catch (err) {
    return await blockPlan(pool, plan, 'EXECUTION_FAILED', `ORDER_CHECK_FAILED: ${(err as Error).message}`);
  }
  if (!ACCEPTED_ORDER_CHECK_RETCODES.includes(Number(check.retcode ?? -1))) {
    return await blockPlan(pool, plan, 'EXECUTION_FAILED', `MT5_RETCODE_${check.retcode}`);
  }

  let result: Record<string, unknown>;
  try {
    result = await sendMt5Order(request, actor.requestId ?? undefined);
  } catch (err) {
    return { allowed: false, code: 'EXECUTION_UNCONFIRMED', reason: (err as Error).message, plan: { ...plan, status: 'PENDING_ORDER_SUBMITTING' } };
  }
  const orderTicket = result.order !== undefined && result.order !== null ? String(result.order) : null;
  const dealTicket = result.deal !== undefined && result.deal !== null ? String(result.deal) : null;
  if (!orderTicket && !dealTicket) return await blockPlan(pool, plan, 'EXECUTION_FAILED', 'RECONCILIATION_FAILED');

  const confirmedPosition = (result.confirmed_position ?? null) as Record<string, unknown> | null;
  const confirmedEntry = numberOrNull(confirmedPosition?.price_open) ?? Number(plan.entry_price ?? 0);
  const confirmedVolume = numberOrNull(confirmedPosition?.volume) ?? volume;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO trade_outcomes(symbol, ai_trade_plan_id, order_ticket, deal_ticket, retcode, side, volume,
          expected_entry, actual_entry, stop_loss, take_profit, risk_amount, risk_reward, account_equity_at_entry, opened_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (ai_trade_plan_id) WHERE ai_trade_plan_id IS NOT NULL DO NOTHING`,
      [plan.symbol, plan.id, orderTicket, dealTicket, result.retcode, side, confirmedVolume.toFixed(8), plan.entry_price, confirmedEntry, plan.stop_loss, plan.take_profit, plan.max_planned_loss, plan.risk_reward, numberOrNull(account?.equity)],
    );
    await client.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', actual_entry=$2, final_volume=$3, mt5_order_ticket=$4, mt5_deal_ticket=$5, retcode=$6, execution_key=NULL, updated_at=now() WHERE id=$1`,
      [plan.id, confirmedEntry, confirmedVolume.toFixed(8), orderTicket, dealTicket, result.retcode],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await createAuditLog(pool, {
    eventType: 'AI_TRADE_PLAN_MARKET_EXECUTED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_trade_plan',
    entityId: String(plan.id),
    action: 'PLACE_MARKET_ORDER',
    afterData: { check, result },
    requestId: actor.requestId ?? null,
  });

  return { allowed: true, code: null, plan: { ...plan, status: 'POSITION_OPEN', order_ticket: orderTicket, deal_ticket: dealTicket, actual_entry: confirmedEntry, final_volume: confirmedVolume } };
}

// ---------------------------------------------------------------------
// Background pending-order confirmation (perf fix — "make DEMO pending-order
// submission feel fast" without ever weakening confirmation discipline).
//
// The trading engine's own synchronous check is now short (spec: <=300-500ms
// beyond order_send()). When it still finds nothing, this continues checking
// on a bounded, non-blocking schedule (500ms/1s/2s/3s — matching what the
// user's spec calls "PART E") using the SAME MT5 read-only evidence lookups
// the stuck-submission watcher and manual-retry paths already use
// (findMt5EvidenceForPlan by execution-key comment — never symbol alone).
// NEVER calls order_send again. If nothing is found anywhere after the full
// bounded window, the plan is resolved to the same EXECUTION_FAILED/
// PENDING_ORDER_NOT_CONFIRMED terminal state the synchronous path used to
// produce immediately — just reached a few seconds later, off the blocking
// HTTP path, giving the broker strictly more real wall-clock time than the
// old ~1.75s single synchronous attempt this replaces. The existing 120s
// reconcileStuckSubmissions watcher is untouched and remains the ultimate
// crash-recovery safety net (e.g. the API process itself restarting
// mid-background-check).
// ---------------------------------------------------------------------
// Overridable (like AI_TRADE_PLAN_WATCHER_INTERVAL_MS) so tests can use real,
// short delays instead of the production schedule — deliberately real
// setTimeout, never vi.useFakeTimers(), since faking global timers alongside
// real pg I/O (which uses its own internal timers) is a known source of
// flaky races.
function backgroundReconcileDelaysMs(): number[] {
  const override = process.env.AI_TRADE_BACKGROUND_RECONCILE_DELAYS_MS;
  if (override) {
    const parsed = override.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v));
    if (parsed.length) return parsed;
  }
  return [500, 500, 1000, 1000]; // cumulative marks: 500ms, 1s, 2s, 3s
}

async function finalizePlanFromLiveEvidence(
  pool: Pool,
  row: Record<string, unknown>,
  matchedOrder: Record<string, unknown> | null,
  matchedPosition: Record<string, unknown> | null,
): Promise<boolean> {
  if (matchedOrder) {
    await pool.query(
      `UPDATE ai_trade_plans SET status='PENDING_ORDER_PLACED', placed_at=now(), mt5_order_ticket=$2, execution_key=NULL, updated_at=now()
       WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
      [row.id, String(matchedOrder.ticket ?? '')],
    );
    return true;
  }
  if (matchedPosition) {
    await pool.query(
      `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_position_ticket=$3, execution_key=NULL, updated_at=now()
       WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
      [row.id, numberOrNull(matchedPosition.price_open) ?? row.entry_price, String(matchedPosition.ticket ?? '')],
    );
    return true;
  }
  return false;
}

function scheduleBackgroundPendingOrderReconciliation(
  pool: Pool,
  plan: Record<string, unknown>,
  actor: Mt5Actor,
  snapshot: Record<string, unknown> | null,
): void {
  const planId = String(plan.id);
  const symbol = String(plan.symbol);
  const startedAt = Date.now();
  const delays = backgroundReconcileDelaysMs();

  const tick = async (attemptIndex: number): Promise<void> => {
    const current = await pool.query(`SELECT * FROM ai_trade_plans WHERE id=$1`, [planId]);
    const row = current.rows[0] as Record<string, unknown> | undefined;
    // Another path (an owner retry click, the 120s stuck-submission
    // watcher, or a previous tick) already resolved this plan — nothing
    // left for this background pass to do.
    if (!row || row.status !== 'PENDING_ORDER_SUBMITTING') return;

    const [pendingOrders, positions] = await Promise.all([
      listMt5PendingOrders(actor.requestId ?? undefined).catch(() => []),
      listMt5Positions(actor.requestId ?? undefined).catch(() => []),
    ]);
    const { matchedOrder, matchedPosition } = findMt5EvidenceForPlan(row, pendingOrders, positions);
    if (await finalizePlanFromLiveEvidence(pool, row, matchedOrder, matchedPosition)) {
      console.log(`[background-reconcile] plan ${planId} confirmed after ${Date.now() - startedAt}ms (attempt ${attemptIndex})`);
      return;
    }

    if (attemptIndex < delays.length) {
      // Expression-body arrow so the returned promise chain is what the
      // setTimeout callback resolves to — needed both for correctness and
      // so test suites using vi.advanceTimersByTimeAsync can actually await
      // this tick's real DB/MT5 I/O instead of racing past it.
      setTimeout(() => tick(attemptIndex + 1).catch((err) => console.error('[background-reconcile] tick failed:', (err as Error).message)), delays[attemptIndex]);
      return;
    }

    // Final attempt: also sweep order/deal HISTORY (a fast fill-and-close,
    // or the broker settling just after the live endpoints were checked,
    // can outrun orders_get()/positions_get() entirely) before ever
    // concluding PENDING_ORDER_NOT_CONFIRMED — the same evidence sources
    // reconcileInconclusiveExecution already checks for a manual retry.
    const [historyOrders, historyDeals] = await Promise.all([
      getMt5HistoryOrders(symbol, 1, actor.requestId ?? undefined).catch(() => []),
      getMt5HistoryDeals(symbol, 1, actor.requestId ?? undefined).catch(() => []),
    ]);
    const comment = planComment(row.id);
    const matchedHistoryOrder = historyOrders.find((o) => String(o.symbol) === symbol && String(o.comment ?? '') === comment);
    if (matchedHistoryOrder && Number(matchedHistoryOrder.state) === MT5_ORDER_STATE_FILLED) {
      await pool.query(
        `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_order_ticket=$3, execution_key=NULL, updated_at=now()
         WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
        [planId, numberOrNull(matchedHistoryOrder.price_open) ?? row.entry_price, String(matchedHistoryOrder.ticket ?? '')],
      );
      console.log(`[background-reconcile] plan ${planId} confirmed via order history after ${Date.now() - startedAt}ms`);
      return;
    }
    const matchedHistoryDeal = historyDeals.find((d) => String(d.symbol) === symbol && String(d.comment ?? '') === comment && Number(d.entry) === MT5_DEAL_ENTRY_IN);
    if (matchedHistoryDeal) {
      const positionTicket = matchedHistoryDeal.position_id ?? matchedHistoryDeal.order ?? null;
      await pool.query(
        `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, mt5_position_ticket=$3, execution_key=NULL, updated_at=now()
         WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
        [planId, numberOrNull(matchedHistoryDeal.price) ?? row.entry_price, positionTicket !== null ? String(positionTicket) : null],
      );
      console.log(`[background-reconcile] plan ${planId} confirmed via deal history after ${Date.now() - startedAt}ms`);
      return;
    }

    // Genuinely no evidence anywhere after the full bounded window —
    // terminal PENDING_ORDER_NOT_CONFIRMED, the same state/diagnostics
    // shape the synchronous path used to produce immediately. Never a
    // second order_send: an owner retry click still goes through
    // reconcileInconclusiveExecution's own fresh MT5 check first.
    await pool.query(
      `UPDATE ai_trade_plans
       SET status='EXECUTION_FAILED', blocked_reason='PENDING_ORDER_NOT_CONFIRMED', execution_key=NULL, updated_at=now(),
           execution_snapshot = COALESCE($2::jsonb, execution_snapshot)
       WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
      [planId, snapshot ? JSON.stringify(snapshot) : null],
    );
    console.log(`[background-reconcile] plan ${planId} unconfirmed after ${Date.now() - startedAt}ms (background_confirmation_ms)`);
  };

  setTimeout(() => tick(1).catch((err) => console.error('[background-reconcile] initial tick failed:', (err as Error).message)), delays[0]);
}

async function placePendingOrder(pool: Pool, plan: Record<string, unknown>, actor: Mt5Actor, volume: number, side: 'BUY' | 'SELL', price: number | null): Promise<AiPlanExecutionOutcome> {
  if (price === null || !Number.isFinite(price)) return await blockPlan(pool, plan, 'EXECUTION_FAILED', 'INVALID_PENDING_PRICE');
  const pendingType = String(plan.pending_order_type) as Mt5PendingOrderRequestDTO['order_type'];
  const request: Mt5PendingOrderRequestDTO = {
    idempotency_key: String(plan.execution_key),
    symbol: String(plan.symbol),
    order_type: pendingType,
    price,
    volume,
    stop_loss: Number(plan.stop_loss),
    take_profit: Number(plan.take_profit),
    expiration: new Date(String(plan.plan_expiry)).toISOString(),
    comment: planComment(plan.id),
  };
  let check: Record<string, unknown>;
  try {
    check = await checkMt5PendingOrder(request, actor.requestId ?? undefined);
  } catch (err) {
    return await blockPlan(pool, plan, 'EXECUTION_FAILED', `ORDER_CHECK_FAILED: ${pendingOrderErrorReason(err)}`);
  }
  // ORDER_CHECK and ORDER_SEND are distinct steps (spec section 4/8) — a
  // passing order_check only proves the request is well-formed/affordable,
  // never execution. Its diagnostics (retcode/comment/margin*) are
  // persisted under their own key even on rejection, never conflated with
  // an order_send result.
  if (!ACCEPTED_ORDER_CHECK_RETCODES.includes(Number(check.retcode ?? -1))) {
    return await blockPlan(pool, plan, 'EXECUTION_FAILED', `MT5_RETCODE_${check.retcode}`, undefined, {
      order_check: {
        retcode: check.retcode ?? null,
        comment: check.comment ?? null,
        margin: check.margin ?? null,
        margin_free: check.margin_free ?? null,
        margin_level: check.margin_level ?? null,
      },
    });
  }

  let result: Record<string, unknown>;
  try {
    result = await sendMt5PendingOrder(request, actor.requestId ?? undefined);
  } catch (err) {
    // The trading engine already ran bounded reconciliation itself across
    // orders_get()/positions_get()/history_orders_get()/history_deals_get()
    // (spec section 1/6/7) before ever raising — a defined status/code here
    // means it reached a DEFINITE answer (rejected, cancelled-per-history,
    // or genuinely ambiguous), so resolve the plan immediately rather than
    // leaving the owner staring at a stuck "submitting" plan for the
    // watcher's grace period. Only a true transport-level failure (no
    // status at all — the engine itself was unreachable/timed out) is left
    // unresolved for reconcileStuckSubmissions, since that really is
    // ambiguous: we do not know whether MT5 ever saw the request.
    if (err instanceof TradingEngineError && err.status !== undefined) {
      const code = err.code ?? 'PENDING_ORDER_REJECTED';
      // The engine's own diagnostics (request/order_check/order_send/
      // last_error — see mt5/adapter.py's MT5DemoSafetyError.diagnostics)
      // must be persisted on every failure path, not only on success — this
      // is exactly the gap that left a prior GBPUSD PENDING_ORDER_NOT_CONFIRMED
      // row with no captured retcode/order/deal at all.
      const engineDiagnostics = (err.diagnostics ?? null) as Record<string, unknown> | null;
      if (code === 'PENDING_ORDER_CANCELLED') {
        // History proved a real, definite cancellation/rejection/expiry —
        // its own distinct terminal lifecycle state (spec section 7), never
        // EXECUTION_FAILED (which would make a future retry attempt think
        // the outcome is still unknown rather than settled).
        return await blockPlan(pool, plan, 'ORDER_CANCELLED', code, pendingOrderErrorReason(err), engineDiagnostics);
      }
      if (code === 'PENDING_ORDER_NOT_CONFIRMED') {
        // The trading engine's own synchronous check is now intentionally
        // SHORT (perf fix: "make DEMO pending-order submission feel fast" —
        // see mt5/adapter.py's _RECONCILE_DELAYS_SECONDS). Reaching this
        // only means the broker had not registered the order within that
        // short window — never a definite failure. Never resend order_send;
        // instead give the broker more real wall-clock time in a bounded,
        // non-blocking background pass while returning to the owner
        // immediately, rather than holding this HTTP request open or
        // declaring failure prematurely (strictly MORE total patience than
        // the old single ~1.75s synchronous attempt this replaces).
        await pool.query(
          `UPDATE ai_trade_plans SET execution_snapshot = COALESCE($2::jsonb, execution_snapshot), updated_at=now()
           WHERE id=$1 AND status='PENDING_ORDER_SUBMITTING'`,
          [plan.id, engineDiagnostics ? JSON.stringify(engineDiagnostics) : null],
        );
        scheduleBackgroundPendingOrderReconciliation(pool, plan, actor, engineDiagnostics);
        return {
          allowed: true,
          code: 'PENDING_CONFIRMATION',
          reason: 'Request was sent to MT5. Confirming the real order/position in the background.',
          plan: { ...plan, status: 'PENDING_ORDER_SUBMITTING', execution_snapshot: engineDiagnostics },
        };
      }
      return await blockPlan(pool, plan, 'EXECUTION_FAILED', code, pendingOrderErrorReason(err), engineDiagnostics);
    }
    return { allowed: false, code: 'EXECUTION_UNCONFIRMED', reason: pendingOrderErrorReason(err), plan: { ...plan, status: 'PENDING_ORDER_SUBMITTING' } };
  }

  const snapshot = safeExecutionSnapshot(result);
  // Missing execution_state means an older trading-engine build that never
  // set it — treat that the same as the historical PENDING behavior rather
  // than failing closed.
  const executionState = typeof result.execution_state === 'string' ? result.execution_state : 'PENDING';

  if (executionState === 'TRIGGERED_POSITION' || executionState === 'FILLED_HISTORY') {
    // IMMEDIATE TRIGGER CASE (spec section 6): the pending order already
    // triggered into a real position — or history already proved it filled
    // — before this ever observed it as a still-active pending order. This
    // plan goes straight to POSITION_OPEN; it must never be reported as
    // PENDING_ORDER_PLACED first (spec section 7).
    const confirmedPosition = (result.confirmed_position ?? null) as Record<string, unknown> | null;
    const historyOrder = (result.confirmed_history_order ?? null) as Record<string, unknown> | null;
    const historyDeal = (result.confirmed_history_deal ?? null) as Record<string, unknown> | null;

    const positionTicket = confirmedPosition?.ticket ?? historyOrder?.ticket ?? historyDeal?.position_id ?? historyDeal?.order ?? null;
    const confirmedEntry = numberOrNull(confirmedPosition?.price_open ?? historyOrder?.price_open ?? historyDeal?.price) ?? Number(plan.entry_price ?? plan.trigger_price ?? 0);
    const confirmedVolume = numberOrNull(confirmedPosition?.volume ?? historyOrder?.volume_current ?? historyOrder?.volume_initial ?? historyDeal?.volume) ?? volume;
    const dealTicketForRecord = historyDeal?.ticket ?? result.deal ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO trade_outcomes(symbol, ai_trade_plan_id, order_ticket, deal_ticket, retcode, side, volume,
            expected_entry, actual_entry, stop_loss, take_profit, risk_amount, risk_reward, opened_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (ai_trade_plan_id) WHERE ai_trade_plan_id IS NOT NULL DO NOTHING`,
        [
          plan.symbol, plan.id,
          positionTicket !== null ? String(positionTicket) : null,
          dealTicketForRecord !== null ? String(dealTicketForRecord) : null,
          result.retcode ?? null, side, String(confirmedVolume),
          plan.entry_price, confirmedEntry, plan.stop_loss, plan.take_profit, plan.max_planned_loss, plan.risk_reward,
        ],
      );
      await client.query(
        `UPDATE ai_trade_plans SET status='POSITION_OPEN', triggered_at=now(), actual_entry=$2, final_volume=$3,
             mt5_position_ticket=$4, retcode=$5, execution_snapshot=$6::jsonb, execution_key=NULL, updated_at=now() WHERE id=$1`,
        [plan.id, confirmedEntry, String(confirmedVolume), positionTicket !== null ? String(positionTicket) : null, result.retcode ?? null, snapshot ? JSON.stringify(snapshot) : null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await createAuditLog(pool, {
      eventType: 'AI_TRADE_PLAN_PENDING_ORDER_TRIGGERED',
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      entityType: 'ai_trade_plan',
      entityId: String(plan.id),
      action: 'PENDING_ORDER_IMMEDIATE_TRIGGER',
      afterData: { check, result },
      requestId: actor.requestId ?? null,
    });

    return { allowed: true, code: null, plan: { ...plan, status: 'POSITION_OPEN', mt5_position_ticket: positionTicket, actual_entry: confirmedEntry, final_volume: confirmedVolume } };
  }

  // execution_state === 'PENDING': still a genuine active pending order.
  const orderTicket = result.order !== undefined && result.order !== null ? String(result.order) : null;
  if (!orderTicket) return await blockPlan(pool, plan, 'EXECUTION_FAILED', 'PENDING_ORDER_NOT_CONFIRMED', undefined, snapshot);

  await pool.query(
    `UPDATE ai_trade_plans SET status='PENDING_ORDER_PLACED', placed_at=now(), mt5_order_ticket=$2, retcode=$3, mt5_request_id=$4, execution_snapshot=$5::jsonb, execution_key=NULL, updated_at=now() WHERE id=$1`,
    [plan.id, orderTicket, result.retcode, result.request_id !== undefined && result.request_id !== null ? String(result.request_id) : null, snapshot ? JSON.stringify(snapshot) : null],
  );

  await createAuditLog(pool, {
    eventType: 'AI_TRADE_PLAN_PENDING_ORDER_PLACED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_trade_plan',
    entityId: String(plan.id),
    action: 'PLACE_PENDING_ORDER',
    afterData: { check, result },
    requestId: actor.requestId ?? null,
  });

  return { allowed: true, code: null, plan: { ...plan, status: 'PENDING_ORDER_PLACED', mt5_order_ticket: orderTicket } };
}

export async function cancelAiTradePlanOrder(pool: Pool, planId: string, actor: Mt5Actor): Promise<AiPlanExecutionOutcome> {
  const current = await pool.query('SELECT * FROM ai_trade_plans WHERE id=$1', [planId]);
  const row = current.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { allowed: false, code: 'PLAN_NOT_FOUND', reason: 'AI trade plan not found', plan: null };
  if (row.status !== 'PENDING_ORDER_PLACED' || !row.mt5_order_ticket) {
    return { allowed: false, code: 'NOT_CANCELLABLE', reason: `Plan is ${row.status}; only a placed pending order can be cancelled.`, plan: row };
  }
  await cancelMt5PendingOrder(String(row.mt5_order_ticket), actor.requestId ?? undefined);
  const updated = await pool.query(
    `UPDATE ai_trade_plans SET status='ORDER_CANCELLED', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status='PENDING_ORDER_PLACED' RETURNING *`,
    [planId],
  );
  await createAuditLog(pool, {
    eventType: 'AI_TRADE_PLAN_ORDER_CANCELLED',
    actorId: actor.actorId,
    actorEmail: actor.actorEmail,
    entityType: 'ai_trade_plan',
    entityId: planId,
    action: 'CANCEL_PENDING_ORDER',
    afterData: { ticket: row.mt5_order_ticket },
    requestId: actor.requestId ?? null,
  });
  return { allowed: true, code: null, plan: updated.rows[0] ?? row };
}

// Terminal/negative states — mirrors blockPlan's own status vocabulary plus
// the plan lifecycle's other definite-stop states, so polling this derives
// exactly the same allowed/code shape the approve endpoint itself returns.
const NEGATIVE_PLAN_STATUSES = new Set([
  'RISK_BLOCKED',
  'EXECUTION_FAILED',
  'ORDER_CANCELLED',
  'PLAN_EXPIRED',
]);

/**
 * GET-friendly status lookup for a single plan (spec: "Frontend polls a
 * status endpoint ... GET /mt5/executions/:executionId ... reuse an existing
 * execution-status endpoint"). Derives the exact same {allowed, code, reason,
 * plan} shape approveAndPlaceAiTradePlan itself returns, so the frontend's
 * existing success/failure/confirming rendering logic (all keyed off
 * approveOutcome.plan.status/.blocked_reason/.execution_snapshot) works
 * unchanged whether the outcome came from the original POST or from polling
 * this GET while a background reconciliation is still in flight.
 */
export async function getAiTradePlanStatus(pool: Pool, planId: string): Promise<AiPlanExecutionOutcome> {
  const result = await pool.query('SELECT * FROM ai_trade_plans WHERE id=$1', [planId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { allowed: false, code: 'PLAN_NOT_FOUND', reason: 'AI trade plan not found', plan: null };

  if (row.status === 'PENDING_ORDER_SUBMITTING') {
    return {
      allowed: true,
      code: 'PENDING_CONFIRMATION',
      reason: 'Request was sent to MT5. Confirming the real order/position in the background.',
      plan: row,
    };
  }
  if (NEGATIVE_PLAN_STATUSES.has(String(row.status))) {
    return { allowed: false, code: String(row.status), reason: (row.blocked_reason as string | null) ?? String(row.status), plan: row };
  }
  // WAITING_FOR_APPROVAL/AI_PLAN_CREATED/PENDING_ORDER_PLACED/
  // PENDING_ORDER_TRIGGERED/POSITION_OPEN/POSITION_CLOSED are all
  // non-negative outcomes as far as this endpoint's shape is concerned —
  // the frontend's own computeds (isPendingOrderSuccess etc.) key off the
  // real plan.status value, not this allowed/code pair.
  return { allowed: true, code: null, plan: row };
}

export { planComment };
