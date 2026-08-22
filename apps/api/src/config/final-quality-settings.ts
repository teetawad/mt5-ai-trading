// Final Quality Score / REAL DEMO selectivity configuration (owner spec:
// "Upgrade ... so the Trading AI becomes more selective for REAL DEMO
// trades ... TOP 5 REAL DEMO candidates per completed M5 cycle"). Same
// env-driven DEFINITIONS pattern as fast-learning-settings.ts/
// mt5-risk-settings.ts. Nothing here ever authorizes execution by itself —
// it only decides which technically-valid, Risk-PASS M5 cycle candidates are
// worth showing as REAL DEMO READY vs SHADOW LEARNING ONLY; the owner still
// manually clicks the DEMO execution button, and every hard MT5/Risk Engine
// block (spec section 15) is untouched by any setting in this file.

export interface FinalQualityWeights {
  aiProfitability: number;
  tradeability: number;
  confidence: number;
  timeframeAlignment: number;
  history: number;
}

export interface FinalQualitySettings {
  // REAL DEMO eligibility gate (spec sections 1/3/31): a candidate must score
  // at least this high (0-100) to ever be considered for REAL DEMO, on top of
  // Risk Engine PASS + broker validation.
  real_demo_min_final_score: number;
  // Max REAL DEMO candidates surfaced per completed M5 cycle (spec sections
  // 2/21/30). Never forced up to this count — fewer qualifying candidates
  // just means a shorter list.
  real_demo_top_candidates: number;
  // Final Quality Score weights (spec section 3) — must sum to 1; see
  // loadFinalQualityWeights, which renormalizes and logs a warning if a
  // misconfigured env leaves them summing to something else.
  final_score_ai_profitability_weight: number;
  final_score_tradeability_weight: number;
  final_score_confidence_weight: number;
  final_score_timeframe_alignment_weight: number;
  final_score_history_weight: number;
  // Sample-count gating for historical performance influence (spec section
  // 6): below this many completed samples for the matched setup family, the
  // historical performance weight is ~0 (its share is redistributed to the
  // other weighted components rather than silently capping the max
  // achievable score).
  historical_min_samples: number;
  // At/above this many samples, historical performance gets its full
  // configured weight. Between historical_min_samples and this value, the
  // weight ramps up linearly.
  historical_full_weight_samples: number;
  // Recent Loss Guard (spec section 8, REAL DEMO eligibility only): this many
  // consecutive completed losses for the same symbol+direction+entry_type
  // family triggers a temporary score penalty.
  recent_loss_streak_threshold: number;
  // Final Quality Score points subtracted when the recent-loss streak
  // threshold is met. Recovers immediately once the streak is broken by a
  // non-loss (spec: "allow the penalty to decay or recover after better
  // results") — never a permanent ban.
  recent_loss_penalty_points: number;
  // Quality-based DEMO sizing (spec sections 12-14).
  quality_based_demo_sizing: boolean;
  quality_tier_high_min_score: number;
  quality_tier_high_max_loss_usd: number;
  quality_tier_normal_min_score: number;
  quality_tier_normal_max_loss_usd: number;
  // Practical ML-readiness heuristic (spec section 28) — never a claim of
  // statistical significance, just an initial recommended sample floor.
  ml_recommended_min_samples: number;
}

type Env = Record<string, string | undefined>;

const DEFINITIONS = {
  real_demo_min_final_score: { env: 'REAL_DEMO_MIN_FINAL_SCORE', defaultValue: 65 },
  real_demo_top_candidates: { env: 'REAL_DEMO_TOP_CANDIDATES', defaultValue: 5 },
  final_score_ai_profitability_weight: { env: 'FINAL_SCORE_AI_PROFITABILITY_WEIGHT', defaultValue: 0.35 },
  final_score_tradeability_weight: { env: 'FINAL_SCORE_TRADEABILITY_WEIGHT', defaultValue: 0.20 },
  final_score_confidence_weight: { env: 'FINAL_SCORE_CONFIDENCE_WEIGHT', defaultValue: 0.15 },
  final_score_timeframe_alignment_weight: { env: 'FINAL_SCORE_TIMEFRAME_ALIGNMENT_WEIGHT', defaultValue: 0.15 },
  final_score_history_weight: { env: 'FINAL_SCORE_HISTORY_WEIGHT', defaultValue: 0.15 },
  historical_min_samples: { env: 'HISTORICAL_MIN_SAMPLES', defaultValue: 20 },
  historical_full_weight_samples: { env: 'HISTORICAL_FULL_WEIGHT_SAMPLES', defaultValue: 50 },
  recent_loss_streak_threshold: { env: 'RECENT_LOSS_STREAK_THRESHOLD', defaultValue: 3 },
  recent_loss_penalty_points: { env: 'RECENT_LOSS_PENALTY_POINTS', defaultValue: 10 },
  quality_based_demo_sizing: { env: 'QUALITY_BASED_DEMO_SIZING', defaultValue: true },
  quality_tier_high_min_score: { env: 'QUALITY_TIER_HIGH_MIN_SCORE', defaultValue: 80 },
  quality_tier_high_max_loss_usd: { env: 'QUALITY_TIER_HIGH_MAX_LOSS_USD', defaultValue: 4.50 },
  quality_tier_normal_min_score: { env: 'QUALITY_TIER_NORMAL_MIN_SCORE', defaultValue: 65 },
  quality_tier_normal_max_loss_usd: { env: 'QUALITY_TIER_NORMAL_MAX_LOSS_USD', defaultValue: 3.00 },
  ml_recommended_min_samples: { env: 'ML_RECOMMENDED_MIN_SAMPLES', defaultValue: 200 },
} as const;

export const FINAL_QUALITY_SETTING_KEYS = Object.keys(DEFINITIONS) as Array<keyof FinalQualitySettings>;

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return fallback;
}

export function loadFinalQualitySettings(env: Env = process.env): FinalQualitySettings {
  return {
    real_demo_min_final_score: parseEnvNumber(env.REAL_DEMO_MIN_FINAL_SCORE, DEFINITIONS.real_demo_min_final_score.defaultValue),
    real_demo_top_candidates: parseEnvNumber(env.REAL_DEMO_TOP_CANDIDATES, DEFINITIONS.real_demo_top_candidates.defaultValue),
    final_score_ai_profitability_weight: parseEnvNumber(env.FINAL_SCORE_AI_PROFITABILITY_WEIGHT, DEFINITIONS.final_score_ai_profitability_weight.defaultValue),
    final_score_tradeability_weight: parseEnvNumber(env.FINAL_SCORE_TRADEABILITY_WEIGHT, DEFINITIONS.final_score_tradeability_weight.defaultValue),
    final_score_confidence_weight: parseEnvNumber(env.FINAL_SCORE_CONFIDENCE_WEIGHT, DEFINITIONS.final_score_confidence_weight.defaultValue),
    final_score_timeframe_alignment_weight: parseEnvNumber(env.FINAL_SCORE_TIMEFRAME_ALIGNMENT_WEIGHT, DEFINITIONS.final_score_timeframe_alignment_weight.defaultValue),
    final_score_history_weight: parseEnvNumber(env.FINAL_SCORE_HISTORY_WEIGHT, DEFINITIONS.final_score_history_weight.defaultValue),
    historical_min_samples: parseEnvNumber(env.HISTORICAL_MIN_SAMPLES, DEFINITIONS.historical_min_samples.defaultValue),
    historical_full_weight_samples: parseEnvNumber(env.HISTORICAL_FULL_WEIGHT_SAMPLES, DEFINITIONS.historical_full_weight_samples.defaultValue),
    recent_loss_streak_threshold: parseEnvNumber(env.RECENT_LOSS_STREAK_THRESHOLD, DEFINITIONS.recent_loss_streak_threshold.defaultValue),
    recent_loss_penalty_points: parseEnvNumber(env.RECENT_LOSS_PENALTY_POINTS, DEFINITIONS.recent_loss_penalty_points.defaultValue),
    quality_based_demo_sizing: parseEnvBoolean(env.QUALITY_BASED_DEMO_SIZING, DEFINITIONS.quality_based_demo_sizing.defaultValue),
    quality_tier_high_min_score: parseEnvNumber(env.QUALITY_TIER_HIGH_MIN_SCORE, DEFINITIONS.quality_tier_high_min_score.defaultValue),
    quality_tier_high_max_loss_usd: parseEnvNumber(env.QUALITY_TIER_HIGH_MAX_LOSS_USD, DEFINITIONS.quality_tier_high_max_loss_usd.defaultValue),
    quality_tier_normal_min_score: parseEnvNumber(env.QUALITY_TIER_NORMAL_MIN_SCORE, DEFINITIONS.quality_tier_normal_min_score.defaultValue),
    quality_tier_normal_max_loss_usd: parseEnvNumber(env.QUALITY_TIER_NORMAL_MAX_LOSS_USD, DEFINITIONS.quality_tier_normal_max_loss_usd.defaultValue),
    ml_recommended_min_samples: parseEnvNumber(env.ML_RECOMMENDED_MIN_SAMPLES, DEFINITIONS.ml_recommended_min_samples.defaultValue),
  };
}

// Weights must sum to 1 (spec section 3: "Validate total weight"). Rather
// than crash the whole scan over a typo'd env value, a misconfigured sum is
// normalized proportionally and logged once so the effective weights always
// add up to exactly 1 without ever silently capping the achievable score.
let loggedWeightWarning = false;

export function loadFinalQualityWeights(settings: FinalQualitySettings = loadFinalQualitySettings()): FinalQualityWeights {
  const raw: FinalQualityWeights = {
    aiProfitability: Math.max(0, settings.final_score_ai_profitability_weight),
    tradeability: Math.max(0, settings.final_score_tradeability_weight),
    confidence: Math.max(0, settings.final_score_confidence_weight),
    timeframeAlignment: Math.max(0, settings.final_score_timeframe_alignment_weight),
    history: Math.max(0, settings.final_score_history_weight),
  };
  const total = raw.aiProfitability + raw.tradeability + raw.confidence + raw.timeframeAlignment + raw.history;
  if (total <= 0) {
    // Nothing usable configured — fall back to the spec's own default split
    // rather than dividing by zero.
    return { aiProfitability: 0.35, tradeability: 0.20, confidence: 0.15, timeframeAlignment: 0.15, history: 0.15 };
  }
  if (Math.abs(total - 1) > 0.001 && !loggedWeightWarning) {
    console.warn(`[final-quality-settings] FINAL_SCORE_*_WEIGHT settings sum to ${total.toFixed(4)}, not 1 — normalizing proportionally.`);
    loggedWeightWarning = true;
  }
  return {
    aiProfitability: raw.aiProfitability / total,
    tradeability: raw.tradeability / total,
    confidence: raw.confidence / total,
    timeframeAlignment: raw.timeframeAlignment / total,
    history: raw.history / total,
  };
}

export function finalQualitySettingsRows(settings: FinalQualitySettings = loadFinalQualitySettings()) {
  return FINAL_QUALITY_SETTING_KEYS.map((key) => ({ key, value: settings[key], source: 'env' }));
}

// Test-only: clears the one-time weight-warning log guard so tests that
// intentionally pass a bad weight sum can assert the warning fires.
export function resetFinalQualityWeightWarningForTests(): void {
  loggedWeightWarning = false;
}
