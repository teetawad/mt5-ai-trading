// Configurable knobs for the "FIND BEST TRADES" two-stage scanner
// (opportunity-scan.ts). Deliberately env-driven so the cost/coverage
// tradeoff (how many MT5-pre-filtered symbols get sent to the paid OpenAI
// stage) can be tuned without a code change.

export interface AiScannerSettings {
  // How many MT5-pre-filtered, technically-shortlisted symbols are actually
  // sent to the Trading AI (OpenAI) per scan run — the one hard cost ceiling
  // on "FIND BEST TRADES" (spec section 5/14: "never analyze every broker
  // symbol blindly", default 20).
  ai_best_trades_shortlist_size: number;
  // How many top-ranked results "FIND BEST TRADES" ever returns per scan
  // (spec section 14/16: "TOP 10 AI TRADE OPPORTUNITIES" — never fabricate
  // more than genuinely exist, but never show more than this either).
  ai_best_trades_top_count: number;
  // Recent-analysis reuse window (spec section 18: "do not analyze the same
  // symbol repeatedly on the same completed market data unless the user
  // explicitly requests refresh"). A shortlisted symbol whose most recent AI
  // analysis is on the SAME completed H1 candle and younger than this many
  // minutes is reused instead of spending a new OpenAI call. Explicit
  // single-symbol ANALYZE WITH AI/VIEW PLAN calls never consult this cache.
  ai_best_trades_reuse_max_age_minutes: number;
}

type Env = Record<string, string | undefined>;

const DEFINITIONS = {
  ai_best_trades_shortlist_size: {
    env: 'AI_BEST_TRADES_SHORTLIST_SIZE',
    defaultValue: 20,
    description: 'How many technically-shortlisted symbols get sent to the paid AI stage per scan.',
  },
  ai_best_trades_top_count: {
    env: 'AI_BEST_TRADES_TOP_COUNT',
    defaultValue: 10,
    description: 'Maximum number of ranked results FIND BEST TRADES returns per scan.',
  },
  ai_best_trades_reuse_max_age_minutes: {
    env: 'AI_BEST_TRADES_REUSE_MAX_AGE_MINUTES',
    defaultValue: 180,
    description: 'Reuse a shortlisted symbol\'s existing AI analysis (same completed H1 candle) instead of a new OpenAI call, up to this many minutes old.',
  },
} as const;

export const AI_SCANNER_SETTING_KEYS = Object.keys(DEFINITIONS) as Array<keyof AiScannerSettings>;

function parseEnvCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.round(parsed);
}

export function loadAiScannerSettings(env: Env = process.env): AiScannerSettings {
  return {
    ai_best_trades_shortlist_size: parseEnvCount(env.AI_BEST_TRADES_SHORTLIST_SIZE, DEFINITIONS.ai_best_trades_shortlist_size.defaultValue),
    ai_best_trades_top_count: parseEnvCount(env.AI_BEST_TRADES_TOP_COUNT, DEFINITIONS.ai_best_trades_top_count.defaultValue),
    ai_best_trades_reuse_max_age_minutes: parseEnvCount(env.AI_BEST_TRADES_REUSE_MAX_AGE_MINUTES, DEFINITIONS.ai_best_trades_reuse_max_age_minutes.defaultValue),
  };
}

export function aiScannerSettingsRows(settings: AiScannerSettings = loadAiScannerSettings()) {
  return AI_SCANNER_SETTING_KEYS.map((key) => ({
    key,
    value: settings[key],
    description: DEFINITIONS[key].description,
    source: 'env',
  }));
}
