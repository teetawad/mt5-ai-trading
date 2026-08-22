import { Pool, PoolClient } from 'pg';
import { setSetting } from '../db/repositories/system-settings';

export interface Mt5RiskSettings {
  mt5_auto_demo_enabled: boolean;
  fast_learning_risk_profile_enabled: boolean;
  mt5_kill_switch_enabled: boolean;
  mt5_max_risk_per_trade_pct: string;
  mt5_max_loss_per_trade: string;
  mt5_max_daily_loss: string;
  mt5_max_drawdown_pct: string;
  mt5_max_simultaneous_positions: number;
  mt5_max_trades_per_day: number;
  mt5_min_risk_reward: string;
  mt5_max_spread_points: number;
  mt5_quote_staleness_seconds: number;
  mt5_allowed_deviation_points: number;
  mt5_cooldown_minutes: number;
  mt5_entry_plan_valid_hours: number;
  mt5_margin_safety_buffer_pct: string;
}

type Env = Record<string, string | undefined>;

const DEFINITIONS = {
  mt5_auto_demo_enabled: {
    env: 'MT5_AUTO_DEMO_ENABLED',
    defaultValue: false,
    description: 'AUTO-DEMO is default off and owner-controlled.',
  },
  fast_learning_risk_profile_enabled: {
    env: 'FAST_LEARNING_RISK_PROFILE',
    defaultValue: false,
    description: 'DEMO Fast Learning risk profile: loosens position/loss defaults below for verified DEMO accounts only.',
  },
  mt5_kill_switch_enabled: {
    env: 'MT5_KILL_SWITCH_ENABLED',
    defaultValue: true,
    description: 'When true, blocks new MT5 demo entries.',
  },
  mt5_max_risk_per_trade_pct: {
    env: 'MT5_MAX_RISK_PER_TRADE_PCT',
    // Default only — conditional on fast_learning_risk_profile_enabled, see
    // loadMt5RiskSettings. An explicit env value always wins either way.
    defaultValue: '0.50',
    fastLearningDefaultValue: '1.0',
    description: 'Max account-equity risk per trade.',
  },
  mt5_max_loss_per_trade: {
    env: 'MT5_MAX_LOSS_PER_TRADE',
    defaultValue: '100.00',
    fastLearningDefaultValue: '3.00',
    description: 'Max monetary loss per demo trade.',
  },
  mt5_max_daily_loss: {
    env: 'MT5_MAX_DAILY_LOSS',
    defaultValue: '300.00',
    description: 'Daily loss limit for new entries.',
  },
  mt5_max_drawdown_pct: {
    env: 'MT5_MAX_DRAWDOWN_PCT',
    defaultValue: '5.00',
    description: 'Max drawdown guard for new entries.',
  },
  mt5_max_simultaneous_positions: {
    env: 'MT5_MAX_SIMULTANEOUS_POSITIONS',
    defaultValue: 3,
    fastLearningDefaultValue: 10,
    description: 'Max open MT5 demo positions.',
  },
  mt5_max_trades_per_day: {
    env: 'MT5_MAX_TRADES_PER_DAY',
    defaultValue: 6,
    fastLearningDefaultValue: 30,
    // Authoritative trading-day boundary is Asia/Bangkok (Thailand time),
    // not UTC or the broker's own server clock — see countTradesToday() in
    // mt5-entry-plan-watcher.ts for why.
    description: 'Max MT5-confirmed demo entries per Thailand (Asia/Bangkok) trading day.',
  },
  mt5_min_risk_reward: {
    env: 'MT5_MIN_RISK_REWARD',
    defaultValue: '1.50',
    description: 'Minimum acceptable reward/risk.',
  },
  mt5_max_spread_points: {
    env: 'MT5_MAX_SPREAD_POINTS',
    defaultValue: 50,
    description: 'Default max spread in symbol points.',
  },
  mt5_quote_staleness_seconds: {
    env: 'MT5_QUOTE_STALENESS_SECONDS',
    defaultValue: 10,
    description: 'Reject execution on stale MT5 quotes.',
  },
  mt5_allowed_deviation_points: {
    env: 'MT5_ALLOWED_DEVIATION_POINTS',
    defaultValue: 20,
    description: 'Max MT5 order deviation.',
  },
  mt5_cooldown_minutes: {
    env: 'MT5_COOLDOWN_MINUTES',
    defaultValue: 60,
    description: 'Per-symbol cooldown between new entries.',
  },
  mt5_entry_plan_valid_hours: {
    env: 'MT5_ENTRY_PLAN_VALID_HOURS',
    defaultValue: 2,
    description: 'Hours before MT5 AI entry plans expire.',
  },
  mt5_margin_safety_buffer_pct: {
    env: 'MT5_MARGIN_SAFETY_BUFFER_PCT',
    defaultValue: '50.00',
    description: 'Max % of current free margin a single new position may require.',
  },
} as const;

export const MT5_RISK_SETTING_KEYS = Object.keys(DEFINITIONS) as Array<keyof Mt5RiskSettings>;

export function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') return true;
  if (normalised === 'false' || normalised === '0') return false;
  return fallback;
}

function parseEnvDecimal(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? value.trim() : fallback;
}

function parseEnvInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Conservative, non-fast-learning constants — the floor effectiveMt5RiskSettings
// falls back to whenever the fast-learning profile is enabled but DEMO
// verification has not (yet) succeeded. Kept in sync with the plain
// defaultValue for each of these 4 keys above.
export const STRICT_FALLBACK_RISK_SETTINGS = {
  mt5_max_simultaneous_positions: DEFINITIONS.mt5_max_simultaneous_positions.defaultValue as number,
  mt5_max_trades_per_day: DEFINITIONS.mt5_max_trades_per_day.defaultValue as number,
  mt5_max_risk_per_trade_pct: DEFINITIONS.mt5_max_risk_per_trade_pct.defaultValue as string,
  mt5_max_loss_per_trade: DEFINITIONS.mt5_max_loss_per_trade.defaultValue as string,
};

export function loadMt5RiskSettings(env: Env = process.env): Mt5RiskSettings {
  const fastLearningRiskProfileEnabled = parseEnvBoolean(env.FAST_LEARNING_RISK_PROFILE, DEFINITIONS.fast_learning_risk_profile_enabled.defaultValue);
  return {
    mt5_auto_demo_enabled: parseEnvBoolean(env.MT5_AUTO_DEMO_ENABLED, DEFINITIONS.mt5_auto_demo_enabled.defaultValue),
    fast_learning_risk_profile_enabled: fastLearningRiskProfileEnabled,
    mt5_kill_switch_enabled: parseEnvBoolean(env.MT5_KILL_SWITCH_ENABLED, DEFINITIONS.mt5_kill_switch_enabled.defaultValue),
    mt5_max_risk_per_trade_pct: parseEnvDecimal(env.MT5_MAX_RISK_PER_TRADE_PCT, fastLearningRiskProfileEnabled ? DEFINITIONS.mt5_max_risk_per_trade_pct.fastLearningDefaultValue : DEFINITIONS.mt5_max_risk_per_trade_pct.defaultValue),
    mt5_max_loss_per_trade: parseEnvDecimal(env.MT5_MAX_LOSS_PER_TRADE, fastLearningRiskProfileEnabled ? DEFINITIONS.mt5_max_loss_per_trade.fastLearningDefaultValue : DEFINITIONS.mt5_max_loss_per_trade.defaultValue),
    mt5_max_daily_loss: parseEnvDecimal(env.MT5_MAX_DAILY_LOSS, DEFINITIONS.mt5_max_daily_loss.defaultValue),
    mt5_max_drawdown_pct: parseEnvDecimal(env.MT5_MAX_DRAWDOWN_PCT, DEFINITIONS.mt5_max_drawdown_pct.defaultValue),
    mt5_max_simultaneous_positions: parseEnvInteger(env.MT5_MAX_SIMULTANEOUS_POSITIONS, fastLearningRiskProfileEnabled ? DEFINITIONS.mt5_max_simultaneous_positions.fastLearningDefaultValue : DEFINITIONS.mt5_max_simultaneous_positions.defaultValue),
    mt5_max_trades_per_day: parseEnvInteger(env.MT5_MAX_TRADES_PER_DAY, fastLearningRiskProfileEnabled ? DEFINITIONS.mt5_max_trades_per_day.fastLearningDefaultValue : DEFINITIONS.mt5_max_trades_per_day.defaultValue),
    mt5_min_risk_reward: parseEnvDecimal(env.MT5_MIN_RISK_REWARD, DEFINITIONS.mt5_min_risk_reward.defaultValue),
    mt5_max_spread_points: parseEnvInteger(env.MT5_MAX_SPREAD_POINTS, DEFINITIONS.mt5_max_spread_points.defaultValue),
    mt5_quote_staleness_seconds: parseEnvInteger(env.MT5_QUOTE_STALENESS_SECONDS, DEFINITIONS.mt5_quote_staleness_seconds.defaultValue),
    mt5_allowed_deviation_points: parseEnvInteger(env.MT5_ALLOWED_DEVIATION_POINTS, DEFINITIONS.mt5_allowed_deviation_points.defaultValue),
    mt5_cooldown_minutes: parseEnvInteger(env.MT5_COOLDOWN_MINUTES, DEFINITIONS.mt5_cooldown_minutes.defaultValue),
    mt5_entry_plan_valid_hours: parseEnvInteger(env.MT5_ENTRY_PLAN_VALID_HOURS, DEFINITIONS.mt5_entry_plan_valid_hours.defaultValue),
    mt5_margin_safety_buffer_pct: parseEnvDecimal(env.MT5_MARGIN_SAFETY_BUFFER_PCT, DEFINITIONS.mt5_margin_safety_buffer_pct.defaultValue),
  };
}

// Defense-in-depth for the Fast Learning DEMO risk profile (spec section 1):
// the loosened position/loss defaults above may only ever take effect once
// MT5 demo verification has actually succeeded for this account. This is an
// additional guard on top of — never a replacement for — the separate,
// unconditional real/live execution block elsewhere in the app; even if
// demoVerified were somehow wrong, no real order can be sent because that
// block does not depend on these risk-sizing settings at all.
export function effectiveMt5RiskSettings(demoVerified: boolean, settings: Mt5RiskSettings = loadMt5RiskSettings()): Mt5RiskSettings {
  if (settings.fast_learning_risk_profile_enabled && !demoVerified) {
    return { ...settings, ...STRICT_FALLBACK_RISK_SETTINGS };
  }
  return settings;
}

export function mt5RiskSettingsRows(settings: Mt5RiskSettings = loadMt5RiskSettings()) {
  return MT5_RISK_SETTING_KEYS.map((key) => ({
    key,
    value: settings[key],
    description: DEFINITIONS[key].description,
    source: 'env',
  }));
}

export async function syncMt5RiskSettingsToDatabase(db: Pool | PoolClient, settings = loadMt5RiskSettings()): Promise<void> {
  await Promise.all(MT5_RISK_SETTING_KEYS.map((key) => setSetting(db, key, settings[key], null)));
}

export function logMt5RiskStartupSummary(settings = loadMt5RiskSettings()): void {
  console.log(`[mt5] demo login: ${process.env.MT5_ALLOWED_DEMO_LOGIN ?? '(not configured)'}`);
  console.log(`[mt5] demo server: ${process.env.MT5_ALLOWED_DEMO_SERVER ?? '(not configured)'}`);
  console.log(`[mt5-risk] kill switch: ${settings.mt5_kill_switch_enabled ? 'ON' : 'OFF'}`);
  console.log(`[mt5-risk] fast learning risk profile: ${settings.fast_learning_risk_profile_enabled ? 'ON' : 'OFF'}`);
  console.log(`[mt5-risk] max simultaneous positions: ${settings.mt5_max_simultaneous_positions}`);
  console.log(`[mt5-risk] max trades/day: ${settings.mt5_max_trades_per_day}`);
  console.log(`[mt5-risk] risk/trade: ${settings.mt5_max_risk_per_trade_pct}%`);
  console.log(`[mt5-risk] max loss/trade: $${Number(settings.mt5_max_loss_per_trade).toFixed(2)}`);
  console.log(`[mt5-risk] max daily loss: $${Number(settings.mt5_max_daily_loss).toFixed(2)}`);
  console.log(`[mt5] auto-demo: ${settings.mt5_auto_demo_enabled ? 'ON' : 'OFF'}`);
}
