import { Pool } from 'pg';
import { FinalQualitySettings, FinalQualityWeights, loadFinalQualitySettings, loadFinalQualityWeights } from '../../config/final-quality-settings';
import { computeHistoricalPerformance, getRecentLossGuard, HistoricalPerformanceResult, RecentLossGuardResult } from './historical-performance';
import { computeMultiTimeframeAlignmentScore, MultiTimeframeAlignmentResult } from './multi-timeframe-alignment';
import { MarketAnalysisPackage } from './types';

// Final Quality Score (owner spec sections 3, 10): the single combined
// evaluation used to rank/select REAL DEMO candidates — NEVER a calibrated
// win probability or guaranteed-profit claim, and never a replacement for
// confidence_pct/tradeability_pct/profitability_score, which stay separately
// reported (spec: "Keep AI metrics separate").

export interface FinalQualityScoreBreakdown {
  aiProfitability: number;
  tradeability: number;
  confidence: number;
  timeframeAlignment: number;
  historicalPerformance: number;
  historicalAdjustment: number;
  historicalAdjustmentReason: string | null;
  finalQualityScore: number;
  weightsUsed: FinalQualityWeights;
  historicalSampleCount: number;
  historicalInfluenceFactor: number;
  multiTimeframeAlignment: MultiTimeframeAlignmentResult;
}

export interface FinalQualityScoreInput {
  profitabilityScore: number;
  tradeabilityPct: number;
  confidencePct: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryType: string;
  pkg: MarketAnalysisPackage;
}

// Renormalizes weights so a historical component whose influence is reduced
// (few samples, spec section 6) never permanently caps the achievable score
// at less than 100 — the other components simply carry historical's unused
// share instead.
function effectiveWeights(base: FinalQualityWeights, historyInfluence: number): FinalQualityWeights {
  const effectiveHistory = base.history * historyInfluence;
  const others = base.aiProfitability + base.tradeability + base.confidence + base.timeframeAlignment;
  const unused = base.history - effectiveHistory;
  if (others <= 0) {
    return { aiProfitability: 0, tradeability: 0, confidence: 0, timeframeAlignment: 0, history: 1 };
  }
  const scaleUp = 1 + unused / others;
  return {
    aiProfitability: base.aiProfitability * scaleUp,
    tradeability: base.tradeability * scaleUp,
    confidence: base.confidence * scaleUp,
    timeframeAlignment: base.timeframeAlignment * scaleUp,
    history: effectiveHistory,
  };
}

export function computeFinalQualityScoreFromParts(
  input: Pick<FinalQualityScoreInput, 'profitabilityScore' | 'tradeabilityPct' | 'confidencePct'>,
  alignment: MultiTimeframeAlignmentResult,
  historical: HistoricalPerformanceResult,
  recentLoss: RecentLossGuardResult,
  weights: FinalQualityWeights,
): FinalQualityScoreBreakdown {
  const used = effectiveWeights(weights, historical.influenceFactor);
  const rawScore =
    used.aiProfitability * input.profitabilityScore +
    used.tradeability * input.tradeabilityPct +
    used.confidence * input.confidencePct +
    used.timeframeAlignment * alignment.score +
    used.history * historical.score;

  const finalQualityScore = Math.max(0, Math.min(100, Math.round(rawScore + recentLoss.adjustment)));

  return {
    aiProfitability: Math.round(input.profitabilityScore),
    tradeability: Math.round(input.tradeabilityPct),
    confidence: Math.round(input.confidencePct),
    timeframeAlignment: alignment.score,
    historicalPerformance: historical.score,
    historicalAdjustment: recentLoss.adjustment,
    historicalAdjustmentReason: recentLoss.reason,
    finalQualityScore,
    weightsUsed: used,
    historicalSampleCount: historical.sampleCount,
    historicalInfluenceFactor: historical.influenceFactor,
    multiTimeframeAlignment: alignment,
  };
}

export async function computeFinalQualityScore(pool: Pool, input: FinalQualityScoreInput, settings: FinalQualitySettings = loadFinalQualitySettings()): Promise<FinalQualityScoreBreakdown> {
  const weights = loadFinalQualityWeights(settings);
  const alignment = computeMultiTimeframeAlignmentScore(input.pkg, input.direction);
  const [historical, recentLoss] = await Promise.all([
    computeHistoricalPerformance(pool, input.symbol, input.direction, settings),
    getRecentLossGuard(pool, input.symbol, input.direction, input.entryType, settings),
  ]);
  return computeFinalQualityScoreFromParts(input, alignment, historical, recentLoss, weights);
}

export type QualityTier = 'HIGH' | 'NORMAL' | 'SHADOW_ONLY';

export interface QualityTierResult {
  tier: QualityTier;
  maxLossUsd: number | null;
}

// Quality-based DEMO sizing tiers (spec sections 12, 31): the tier's own
// absolute max loss is only ever ONE of several caps the Risk Engine applies
// (spec: "use the smaller of quality-tier absolute max loss, account
// percentage risk limit, broker volume constraints, available margin
// constraints") — see m5-opportunity-scan.ts's applyQualityBasedSizing.
export function qualityTierFor(finalQualityScore: number, settings: FinalQualitySettings = loadFinalQualitySettings()): QualityTierResult {
  if (!settings.quality_based_demo_sizing) return { tier: finalQualityScore >= settings.real_demo_min_final_score ? 'NORMAL' : 'SHADOW_ONLY', maxLossUsd: null };
  if (finalQualityScore >= settings.quality_tier_high_min_score) return { tier: 'HIGH', maxLossUsd: settings.quality_tier_high_max_loss_usd };
  if (finalQualityScore >= settings.quality_tier_normal_min_score) return { tier: 'NORMAL', maxLossUsd: settings.quality_tier_normal_max_loss_usd };
  return { tier: 'SHADOW_ONLY', maxLossUsd: null };
}
