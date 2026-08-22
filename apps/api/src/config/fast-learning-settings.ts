// M5 Fast Learning Mode configuration (spec section 1, 4, 17, 20). Deliberately
// env-driven, same DEFINITIONS pattern as mt5-risk-settings.ts/ai-scanner-settings.ts,
// so the feature can be enabled/tuned without a code change. FAST_LEARNING_MODE
// increases decision/sample FREQUENCY only — it never changes per-trade risk
// sizing, which stays exclusively governed by mt5-risk-settings.ts (spec section 20).

export interface FastLearningSettings {
  // Master switch (spec section 1). Off by default. When false, the M5 cycle
  // scheduler and shadow trade watcher both no-op every tick — nothing about
  // real MT5 DEMO execution is gated by this flag either way.
  fast_learning_mode_enabled: boolean;
  // How often the scheduler checks whether a new M5 candle boundary has
  // closed (spec section 1: "trigger analysis once when a new completed M5
  // candle becomes available", not continuously every second).
  m5_cycle_poll_interval_ms: number;
  // Cost ceiling on the M5 cycle's own paid OpenAI stage (spec section 17):
  // only the top-N M5/M15-weighted shortlisted symbols are analyzed per cycle.
  m5_ai_shortlist_size: number;
  // Default short-lived plan expiry for M5-cycle-triggered plans (spec
  // section 4) — a fallback only; the AI's own plan_expiry_minutes is still
  // used when present and sane, this is never a forced 5-minute cutoff.
  m5_plan_expiry_minutes: number;
  // Recent-analysis reuse window for the M5-keyed cache (spec section 1's
  // "never analyze the same symbol/candle repeatedly"). Deliberately shorter
  // than AI_BEST_TRADES_REUSE_MAX_AGE_MINUTES since M5 candles close every 5
  // minutes — must stay under 5 to avoid bleeding into the next candle.
  m5_reuse_max_age_minutes: number;
  // Shadow trade lifecycle watcher poll interval (spec sections 7/8: monitor
  // pending triggers and open shadow positions against subsequent price data).
  m5_shadow_watcher_interval_ms: number;
  // If neither TP nor SL is touched within this many minutes of shadow entry,
  // the shadow trade is closed as TIME_EXIT (spec section 8) rather than left
  // open forever — the AI's own expected_holding_minutes is used when shorter.
  m5_shadow_max_holding_minutes: number;
  // Spec section 12: "one active real DEMO plan/order per symbol" — blocks
  // approving a second AI trade plan for a symbol that already has another
  // plan mid-flight toward or in a real MT5 position. Never applies to
  // Shadow Trades, which are explicitly allowed to overlap for evaluation
  // (spec section 12: "Shadow trades may continue for evaluation").
  mt5_one_active_plan_per_symbol: boolean;
}

type Env = Record<string, string | undefined>;

const DEFINITIONS = {
  fast_learning_mode_enabled: {
    env: 'FAST_LEARNING_MODE',
    defaultValue: false,
    description: 'Master switch for M5 Fast Learning Mode (auto M5-cycle scans + Shadow Trades). Off by default.',
  },
  m5_cycle_poll_interval_ms: {
    env: 'M5_CYCLE_POLL_INTERVAL_MS',
    defaultValue: 10_000,
    description: 'How often the scheduler checks for a newly completed M5 candle boundary.',
  },
  m5_ai_shortlist_size: {
    env: 'M5_AI_SHORTLIST_SIZE',
    defaultValue: 10,
    description: 'Max symbols sent to the paid AI stage per M5 cycle.',
  },
  m5_plan_expiry_minutes: {
    env: 'M5_PLAN_EXPIRY_MINUTES',
    defaultValue: 30,
    description: 'Fallback plan expiry (minutes) for M5-cycle-triggered plans when the AI does not specify one.',
  },
  m5_reuse_max_age_minutes: {
    env: 'M5_REUSE_MAX_AGE_MINUTES',
    defaultValue: 4,
    description: 'Reuse a shortlisted symbol\'s existing AI analysis (same completed M5 candle) instead of a new OpenAI call, up to this many minutes old.',
  },
  m5_shadow_watcher_interval_ms: {
    env: 'M5_SHADOW_WATCHER_INTERVAL_MS',
    defaultValue: 20_000,
    description: 'Shadow trade lifecycle watcher poll interval.',
  },
  m5_shadow_max_holding_minutes: {
    env: 'M5_SHADOW_MAX_HOLDING_MINUTES',
    defaultValue: 180,
    description: 'Max minutes a shadow trade stays open before a TIME_EXIT close if neither TP nor SL was touched.',
  },
  mt5_one_active_plan_per_symbol: {
    env: 'MT5_ONE_ACTIVE_PLAN_PER_SYMBOL',
    defaultValue: true,
    description: 'Blocks approving a second real DEMO AI trade plan for a symbol that already has one mid-flight.',
  },
} as const;

export const FAST_LEARNING_SETTING_KEYS = Object.keys(DEFINITIONS) as Array<keyof FastLearningSettings>;

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return fallback;
}

function parseEnvCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.round(parsed);
}

export function loadFastLearningSettings(env: Env = process.env): FastLearningSettings {
  return {
    fast_learning_mode_enabled: parseEnvBoolean(env.FAST_LEARNING_MODE, DEFINITIONS.fast_learning_mode_enabled.defaultValue),
    m5_cycle_poll_interval_ms: parseEnvCount(env.M5_CYCLE_POLL_INTERVAL_MS, DEFINITIONS.m5_cycle_poll_interval_ms.defaultValue),
    m5_ai_shortlist_size: parseEnvCount(env.M5_AI_SHORTLIST_SIZE, DEFINITIONS.m5_ai_shortlist_size.defaultValue),
    m5_plan_expiry_minutes: parseEnvCount(env.M5_PLAN_EXPIRY_MINUTES, DEFINITIONS.m5_plan_expiry_minutes.defaultValue),
    m5_reuse_max_age_minutes: parseEnvCount(env.M5_REUSE_MAX_AGE_MINUTES, DEFINITIONS.m5_reuse_max_age_minutes.defaultValue),
    m5_shadow_watcher_interval_ms: parseEnvCount(env.M5_SHADOW_WATCHER_INTERVAL_MS, DEFINITIONS.m5_shadow_watcher_interval_ms.defaultValue),
    m5_shadow_max_holding_minutes: parseEnvCount(env.M5_SHADOW_MAX_HOLDING_MINUTES, DEFINITIONS.m5_shadow_max_holding_minutes.defaultValue),
    mt5_one_active_plan_per_symbol: parseEnvBoolean(env.MT5_ONE_ACTIVE_PLAN_PER_SYMBOL, DEFINITIONS.mt5_one_active_plan_per_symbol.defaultValue),
  };
}

export function fastLearningSettingsRows(settings: FastLearningSettings = loadFastLearningSettings()) {
  return FAST_LEARNING_SETTING_KEYS.map((key) => ({
    key,
    value: settings[key],
    description: DEFINITIONS[key].description,
    source: 'env',
  }));
}
