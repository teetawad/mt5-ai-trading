import { Pool, PoolClient } from 'pg';
import { setSetting } from '../db/repositories/system-settings';

export interface Mt5RiskSettings {
  mt5_auto_demo_enabled: boolean;
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
}

type Env = Record<string, string | undefined>;

const DEFINITIONS = {
  mt5_auto_demo_enabled: {
    env: 'MT5_AUTO_DEMO_ENABLED',
    defaultValue: false,
    description: 'AUTO-DEMO is default off and owner-controlled.',
  },
  mt5_kill_switch_enabled: {
    env: 'MT5_KILL_SWITCH_ENABLED',
    defaultValue: true,
    description: 'When true, blocks new MT5 demo entries.',
  },
  mt5_max_risk_per_trade_pct: {
    env: 'MT5_MAX_RISK_PER_TRADE_PCT',
    defaultValue: '0.50',
    description: 'Max account-equity risk per trade.',
  },
  mt5_max_loss_per_trade: {
    env: 'MT5_MAX_LOSS_PER_TRADE',
    defaultValue: '100.00',
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
    description: 'Max open MT5 demo positions.',
  },
  mt5_max_trades_per_day: {
    env: 'MT5_MAX_TRADES_PER_DAY',
    defaultValue: 6,
    description: 'Max MT5 demo entries per UTC day.',
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

export function loadMt5RiskSettings(env: Env = process.env): Mt5RiskSettings {
  return {
    mt5_auto_demo_enabled: parseEnvBoolean(env.MT5_AUTO_DEMO_ENABLED, DEFINITIONS.mt5_auto_demo_enabled.defaultValue),
    mt5_kill_switch_enabled: parseEnvBoolean(env.MT5_KILL_SWITCH_ENABLED, DEFINITIONS.mt5_kill_switch_enabled.defaultValue),
    mt5_max_risk_per_trade_pct: parseEnvDecimal(env.MT5_MAX_RISK_PER_TRADE_PCT, DEFINITIONS.mt5_max_risk_per_trade_pct.defaultValue),
    mt5_max_loss_per_trade: parseEnvDecimal(env.MT5_MAX_LOSS_PER_TRADE, DEFINITIONS.mt5_max_loss_per_trade.defaultValue),
    mt5_max_daily_loss: parseEnvDecimal(env.MT5_MAX_DAILY_LOSS, DEFINITIONS.mt5_max_daily_loss.defaultValue),
    mt5_max_drawdown_pct: parseEnvDecimal(env.MT5_MAX_DRAWDOWN_PCT, DEFINITIONS.mt5_max_drawdown_pct.defaultValue),
    mt5_max_simultaneous_positions: parseEnvInteger(env.MT5_MAX_SIMULTANEOUS_POSITIONS, DEFINITIONS.mt5_max_simultaneous_positions.defaultValue),
    mt5_max_trades_per_day: parseEnvInteger(env.MT5_MAX_TRADES_PER_DAY, DEFINITIONS.mt5_max_trades_per_day.defaultValue),
    mt5_min_risk_reward: parseEnvDecimal(env.MT5_MIN_RISK_REWARD, DEFINITIONS.mt5_min_risk_reward.defaultValue),
    mt5_max_spread_points: parseEnvInteger(env.MT5_MAX_SPREAD_POINTS, DEFINITIONS.mt5_max_spread_points.defaultValue),
    mt5_quote_staleness_seconds: parseEnvInteger(env.MT5_QUOTE_STALENESS_SECONDS, DEFINITIONS.mt5_quote_staleness_seconds.defaultValue),
    mt5_allowed_deviation_points: parseEnvInteger(env.MT5_ALLOWED_DEVIATION_POINTS, DEFINITIONS.mt5_allowed_deviation_points.defaultValue),
    mt5_cooldown_minutes: parseEnvInteger(env.MT5_COOLDOWN_MINUTES, DEFINITIONS.mt5_cooldown_minutes.defaultValue),
    mt5_entry_plan_valid_hours: parseEnvInteger(env.MT5_ENTRY_PLAN_VALID_HOURS, DEFINITIONS.mt5_entry_plan_valid_hours.defaultValue),
  };
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
  console.log(`[mt5-risk] risk/trade: ${settings.mt5_max_risk_per_trade_pct}%`);
  console.log(`[mt5-risk] max loss/trade: $${Number(settings.mt5_max_loss_per_trade).toFixed(2)}`);
  console.log(`[mt5-risk] max daily loss: $${Number(settings.mt5_max_daily_loss).toFixed(2)}`);
  console.log(`[mt5] auto-demo: ${settings.mt5_auto_demo_enabled ? 'ON' : 'OFF'}`);
}
