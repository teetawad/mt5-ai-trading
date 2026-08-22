import { describe, expect, it } from 'vitest';
import {
  computeFinalQualityScoreFromParts,
  qualityTierFor,
} from '../services/trading-ai/final-quality-score';
import { historicalInfluenceFactor, historicalPerformanceScoreFor, HistoricalPerformanceResult, PerformanceBucketStats, RecentLossGuardResult } from '../services/trading-ai/historical-performance';
import { MultiTimeframeAlignmentResult } from '../services/trading-ai/multi-timeframe-alignment';
import { FinalQualityWeights, loadFinalQualitySettings, loadFinalQualityWeights, resetFinalQualityWeightWarningForTests } from '../config/final-quality-settings';

const DEFAULT_WEIGHTS: FinalQualityWeights = { aiProfitability: 0.35, tradeability: 0.20, confidence: 0.15, timeframeAlignment: 0.15, history: 0.15 };
const FULL_ALIGNMENT: MultiTimeframeAlignmentResult = { score: 100, breakdown: { h4: 25, h1: 30, m15: 25, m5: 20 } };
const NO_ADJUSTMENT: RecentLossGuardResult = { adjustment: 0, consecutiveLosses: 0, reason: null };

function historyResult(sampleCount: number, score = 50): HistoricalPerformanceResult {
  const stats: PerformanceBucketStats = {
    sampleCount, wins: 0, losses: 0, winRate: 0, averageR: null, profitFactor: null,
    netPnl: null, averageMfeR: null, averageMaeR: null, averageHoldingMinutes: null,
  };
  return { score, sampleCount, influenceFactor: historicalInfluenceFactor(sampleCount, { historical_min_samples: 20, historical_full_weight_samples: 50 }), stats };
}

describe('computeFinalQualityScoreFromParts (spec section 29)', () => {
  it('computes Final Quality correctly with high AI profitability/tradeability/alignment and no history', () => {
    const result = computeFinalQualityScoreFromParts(
      { profitabilityScore: 90, tradeabilityPct: 90, confidencePct: 85 },
      FULL_ALIGNMENT,
      historyResult(0),
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    // No history samples -> historical weight redistributed to the other
    // four components, which are all high -> a high final score.
    expect(result.historicalInfluenceFactor).toBe(0);
    expect(result.finalQualityScore).toBeGreaterThanOrEqual(85);
    expect(result.finalQualityScore).toBeLessThanOrEqual(100);
  });

  it('samples < 20 -> historical influence is approximately zero', () => {
    const result = computeFinalQualityScoreFromParts(
      { profitabilityScore: 70, tradeabilityPct: 70, confidencePct: 70 },
      FULL_ALIGNMENT,
      historyResult(10, 5), // terrible history score, but should barely matter
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    expect(result.historicalInfluenceFactor).toBe(0);
    // With zero historical influence the weak history score (5) must not
    // drag the final score down at all.
    const noHistory = computeFinalQualityScoreFromParts(
      { profitabilityScore: 70, tradeabilityPct: 70, confidencePct: 70 },
      FULL_ALIGNMENT,
      historyResult(0, 50),
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    expect(result.finalQualityScore).toBe(noHistory.finalQualityScore);
  });

  it('samples 20-49 -> partial historical influence', () => {
    const result = computeFinalQualityScoreFromParts(
      { profitabilityScore: 70, tradeabilityPct: 70, confidencePct: 70 },
      FULL_ALIGNMENT,
      historyResult(35, 90),
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    expect(result.historicalInfluenceFactor).toBeGreaterThan(0);
    expect(result.historicalInfluenceFactor).toBeLessThan(1);
    expect(result.historicalInfluenceFactor).toBeCloseTo(15 / 30, 5); // (35-20)/(50-20)
  });

  it('samples >= 50 -> full configured historical influence', () => {
    const highHistory = computeFinalQualityScoreFromParts(
      { profitabilityScore: 60, tradeabilityPct: 60, confidencePct: 60 },
      FULL_ALIGNMENT,
      historyResult(80, 95),
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    const lowHistory = computeFinalQualityScoreFromParts(
      { profitabilityScore: 60, tradeabilityPct: 60, confidencePct: 60 },
      FULL_ALIGNMENT,
      historyResult(80, 10),
      NO_ADJUSTMENT,
      DEFAULT_WEIGHTS,
    );
    expect(highHistory.historicalInfluenceFactor).toBe(1);
    // Full weight means a historically strong vs. weak setup family (same
    // AI inputs) must produce a materially different final score.
    expect(highHistory.finalQualityScore).toBeGreaterThan(lowHistory.finalQualityScore + 10);
  });

  it('a historically weak setup gets a negative-leaning historical performance score', () => {
    const weakStats: PerformanceBucketStats = { sampleCount: 60, wins: 15, losses: 45, winRate: 0.25, averageR: -0.4, profitFactor: 0.6, netPnl: -50, averageMfeR: null, averageMaeR: null, averageHoldingMinutes: null };
    const score = historicalPerformanceScoreFor(weakStats);
    expect(score).toBeLessThan(50);
  });

  it('a historically strong setup gets a positive historical performance score', () => {
    const strongStats: PerformanceBucketStats = { sampleCount: 60, wins: 40, losses: 20, winRate: 0.667, averageR: 0.5, profitFactor: 1.8, netPnl: 200, averageMfeR: null, averageMaeR: null, averageHoldingMinutes: null };
    const score = historicalPerformanceScoreFor(strongStats);
    expect(score).toBeGreaterThan(50);
  });
});

describe('Final Quality threshold behavior (spec section 31)', () => {
  it('a score of 64 is below the default REAL DEMO threshold (65)', () => {
    const settings = loadFinalQualitySettings();
    expect(64).toBeLessThan(settings.real_demo_min_final_score);
  });

  it('a score of 65 meets the default REAL DEMO threshold', () => {
    const settings = loadFinalQualitySettings();
    expect(65).toBeGreaterThanOrEqual(settings.real_demo_min_final_score);
  });

  it('a score of 85 qualifies for the HIGH sizing tier', () => {
    const tier = qualityTierFor(85);
    expect(tier.tier).toBe('HIGH');
  });
});

describe('qualityTierFor (spec sections 12, 32)', () => {
  it('score 70 -> NORMAL tier, max planned loss <= $3.00', () => {
    const tier = qualityTierFor(70);
    expect(tier.tier).toBe('NORMAL');
    expect(tier.maxLossUsd).toBeLessThanOrEqual(3.00);
  });

  it('score 85 -> HIGH tier, max planned loss <= $4.50', () => {
    const tier = qualityTierFor(85);
    expect(tier.tier).toBe('HIGH');
    expect(tier.maxLossUsd).toBeLessThanOrEqual(4.50);
  });

  it('score below the REAL DEMO threshold -> SHADOW_ONLY, no sizing', () => {
    const tier = qualityTierFor(50);
    expect(tier.tier).toBe('SHADOW_ONLY');
    expect(tier.maxLossUsd).toBeNull();
  });
});

describe('loadFinalQualityWeights', () => {
  it('normalizes weights that do not sum to 1', () => {
    resetFinalQualityWeightWarningForTests();
    const weights = loadFinalQualityWeights({
      real_demo_min_final_score: 65, real_demo_top_candidates: 5,
      final_score_ai_profitability_weight: 1, final_score_tradeability_weight: 1, final_score_confidence_weight: 1,
      final_score_timeframe_alignment_weight: 1, final_score_history_weight: 1,
      historical_min_samples: 20, historical_full_weight_samples: 50,
      recent_loss_streak_threshold: 3, recent_loss_penalty_points: 10,
      quality_based_demo_sizing: true, quality_tier_high_min_score: 80, quality_tier_high_max_loss_usd: 4.5,
      quality_tier_normal_min_score: 65, quality_tier_normal_max_loss_usd: 3, ml_recommended_min_samples: 200,
    });
    const total = weights.aiProfitability + weights.tradeability + weights.confidence + weights.timeframeAlignment + weights.history;
    expect(total).toBeCloseTo(1, 5);
    expect(weights.aiProfitability).toBeCloseTo(0.2, 5);
  });
});
