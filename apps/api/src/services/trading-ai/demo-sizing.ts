import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { getMt5SymbolInfo } from '../mt5-client';
import { evaluateMt5Risk, toRiskSymbolInfo } from '../mt5-risk-engine';
import { FinalQualitySettings } from '../../config/final-quality-settings';
import { qualityTierFor, QualityTier } from './final-quality-score';
import { LiveAccountState } from './opportunity-scan';

// Quality-based DEMO sizing (owner spec sections 11-14, 32): a REAL DEMO
// candidate's planned max loss is capped by its Final Quality tier
// (HIGH=$4.50, NORMAL=$3.00 by default) — but that tier cap is only ever ONE
// of several caps the Risk Engine already enforces (spec: "use the smaller
// of quality-tier absolute max loss, account percentage risk limit, broker
// volume constraints, available margin constraints"). This module never
// bypasses evaluateMt5Risk's own hard checks; it only re-runs that same
// engine with the tier's dollar cap substituted for the flat
// mt5_max_loss_per_trade setting, exactly like reevaluateRiskForReusedPlan's
// existing risk-freshness pattern in opportunity-scan.ts.

export interface QualityBasedSizingResult {
  tier: QualityTier;
  maxLossUsd: number | null;
  // True only when ai_trade_plans was actually updated to the tier-based
  // sizing. False (with the plan's original, already Risk-PASS sizing left
  // untouched) whenever the bigger size doesn't fit inside margin/broker
  // constraints, or the plan already moved past WAITING_FOR_APPROVAL —
  // upsizing a candidate is best-effort and never blocks an otherwise-valid
  // REAL DEMO candidate.
  applied: boolean;
  recommendedVolume: string | null;
  maxPlannedLoss: string | null;
  targetProfit: string | null;
  reason: string | null;
}

export async function applyQualityBasedSizing(
  pool: Pool,
  planRow: Record<string, unknown>,
  finalQualityScore: number,
  liveState: LiveAccountState,
  riskSettingsRecord: Record<string, unknown>,
  settings: FinalQualitySettings,
  requestId?: string,
): Promise<QualityBasedSizingResult> {
  const { tier, maxLossUsd } = qualityTierFor(finalQualityScore, settings);
  if (tier === 'SHADOW_ONLY' || maxLossUsd === null) {
    return { tier, maxLossUsd, applied: false, recommendedVolume: null, maxPlannedLoss: null, targetProfit: null, reason: null };
  }

  const symbol = String(planRow.symbol);
  const symbolInfoRaw = await getMt5SymbolInfo(symbol, requestId).catch(() => null);
  const referenceEntry = Number(planRow.entry_price ?? planRow.entry_zone_high ?? planRow.trigger_price ?? planRow.current_price ?? 0);
  const overriddenSettings = { ...riskSettingsRecord, mt5_max_loss_per_trade: String(maxLossUsd) };

  const risk = evaluateMt5Risk({
    decision: (planRow.decision as 'BUY' | 'SELL' | 'HOLD' | 'NO_TRADE') ?? 'HOLD',
    referenceEntry: String(referenceEntry),
    stopLoss: planRow.stop_loss !== null && planRow.stop_loss !== undefined ? String(planRow.stop_loss) : null,
    takeProfit: planRow.take_profit !== null && planRow.take_profit !== undefined ? String(planRow.take_profit) : null,
    riskReward: planRow.risk_reward !== null && planRow.risk_reward !== undefined ? String(planRow.risk_reward) : null,
    confidence: Number(planRow.confidence_pct) || 0,
    account: liveState.status.account,
    terminal: liveState.status.terminal,
    settings: overriddenSettings,
    openPositions: liveState.positions.length,
    tradesToday: liveState.tradesToday,
    marketStatus: liveState.status.connected ? 'OPEN' : 'UNKNOWN',
    dataStatus: liveState.status.demo_verified ? 'LIVE' : 'DISCONNECTED',
    symbol: toRiskSymbolInfo(symbolInfoRaw),
    leverage: Number(liveState.status.account?.leverage) || null,
  });

  if (risk.result !== 'PASS') {
    return { tier, maxLossUsd, applied: false, recommendedVolume: null, maxPlannedLoss: null, targetProfit: null, reason: `TIER_RESIZE_NOT_APPLIED: ${risk.failedRules.join(', ')}` };
  }

  // Target Profit follows the AI's own entry/SL/TP/R:R (spec section 13:
  // "Do NOT artificially increase target profit") — only the dollar risk
  // budget scales with the tier, the price levels never move, so scaling
  // riskAmount by the plan's existing risk_reward is the correct (not
  // inflated) dollar target for the new size.
  const riskReward = Number(planRow.risk_reward) || 0;
  const targetProfit = new Decimal(risk.riskAmount).mul(riskReward).toFixed(8);

  const updateResult = await pool.query(
    `UPDATE ai_trade_plans SET recommended_volume=$2, max_planned_loss=$3, target_profit=$4, risk_snapshot=$5, updated_at=now()
     WHERE id=$1 AND status='WAITING_FOR_APPROVAL'
     RETURNING id`,
    [planRow.id, risk.recommendedVolume, risk.riskAmount, targetProfit, JSON.stringify(risk.snapshot)],
  );

  if (!updateResult.rowCount) {
    return { tier, maxLossUsd, applied: false, recommendedVolume: null, maxPlannedLoss: null, targetProfit: null, reason: 'PLAN_NOT_WAITING_FOR_APPROVAL' };
  }

  return { tier, maxLossUsd, applied: true, recommendedVolume: risk.recommendedVolume, maxPlannedLoss: risk.riskAmount, targetProfit, reason: null };
}
