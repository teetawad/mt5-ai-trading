import { describe, expect, it } from 'vitest';
import { loadMt5RiskSettings, mt5RiskSettingsRows, parseEnvBoolean } from '../config/mt5-risk-settings';

describe('MT5 risk settings', () => {
  it('parses boolean strings explicitly', () => {
    expect(parseEnvBoolean('false', true)).toBe(false);
    expect(parseEnvBoolean('true', false)).toBe(true);
    expect(parseEnvBoolean('0', true)).toBe(false);
    expect(parseEnvBoolean('1', false)).toBe(true);
  });

  it('loads all configured numeric MT5 risk values from environment', () => {
    const settings = loadMt5RiskSettings({
      MT5_AUTO_DEMO_ENABLED: 'false',
      MT5_KILL_SWITCH_ENABLED: 'false',
      MT5_MAX_RISK_PER_TRADE_PCT: '0.50',
      MT5_MAX_LOSS_PER_TRADE: '2.00',
      MT5_MAX_DAILY_LOSS: '10.00',
      MT5_MAX_DRAWDOWN_PCT: '5.00',
      MT5_MAX_SIMULTANEOUS_POSITIONS: '3',
      MT5_MAX_TRADES_PER_DAY: '6',
      MT5_MIN_RISK_REWARD: '1.50',
      MT5_MAX_SPREAD_POINTS: '50',
      MT5_QUOTE_STALENESS_SECONDS: '10',
      MT5_ALLOWED_DEVIATION_POINTS: '20',
      MT5_COOLDOWN_MINUTES: '60',
    });

    expect(settings).toMatchObject({
      mt5_auto_demo_enabled: false,
      mt5_kill_switch_enabled: false,
      mt5_max_risk_per_trade_pct: '0.50',
      mt5_max_loss_per_trade: '2.00',
      mt5_max_daily_loss: '10.00',
      mt5_max_drawdown_pct: '5.00',
      mt5_max_simultaneous_positions: 3,
      mt5_max_trades_per_day: 6,
      mt5_min_risk_reward: '1.50',
      mt5_max_spread_points: 50,
      mt5_quote_staleness_seconds: 10,
      mt5_allowed_deviation_points: 20,
      mt5_cooldown_minutes: 60,
    });
  });

  it('exposes endpoint rows from the active settings object', () => {
    const rows = mt5RiskSettingsRows(loadMt5RiskSettings({
      MT5_KILL_SWITCH_ENABLED: '0',
      MT5_MAX_LOSS_PER_TRADE: '2.00',
      MT5_MAX_DAILY_LOSS: '10.00',
    }));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey.mt5_kill_switch_enabled).toBe(false);
    expect(byKey.mt5_max_loss_per_trade).toBe('2.00');
    expect(byKey.mt5_max_daily_loss).toBe('10.00');
  });
});
