import { describe, expect, it } from 'vitest';
import { effectiveMt5RiskSettings, loadMt5RiskSettings, mt5RiskSettingsRows, parseEnvBoolean } from '../config/mt5-risk-settings';

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

  describe('DEMO Fast Learning risk profile', () => {
    it('defaults to the conservative limits when FAST_LEARNING_RISK_PROFILE is unset', () => {
      const settings = loadMt5RiskSettings({});
      expect(settings.fast_learning_risk_profile_enabled).toBe(false);
      expect(settings.mt5_max_simultaneous_positions).toBe(3);
      expect(settings.mt5_max_trades_per_day).toBe(6);
      expect(settings.mt5_max_risk_per_trade_pct).toBe('0.50');
      expect(settings.mt5_max_loss_per_trade).toBe('100.00');
    });

    it('loosens the defaults to 10/30/1.0/3.00 when FAST_LEARNING_RISK_PROFILE=true', () => {
      const settings = loadMt5RiskSettings({ FAST_LEARNING_RISK_PROFILE: 'true' });
      expect(settings.fast_learning_risk_profile_enabled).toBe(true);
      expect(settings.mt5_max_simultaneous_positions).toBe(10);
      expect(settings.mt5_max_trades_per_day).toBe(30);
      expect(settings.mt5_max_risk_per_trade_pct).toBe('1.0');
      expect(settings.mt5_max_loss_per_trade).toBe('3.00');
    });

    it('an explicit MT5_MAX_* env value always wins over either default set', () => {
      const off = loadMt5RiskSettings({ MT5_MAX_SIMULTANEOUS_POSITIONS: '7' });
      expect(off.mt5_max_simultaneous_positions).toBe(7);
      const on = loadMt5RiskSettings({ FAST_LEARNING_RISK_PROFILE: 'true', MT5_MAX_SIMULTANEOUS_POSITIONS: '7' });
      expect(on.mt5_max_simultaneous_positions).toBe(7);
    });

    it('effectiveMt5RiskSettings forces the strict limits back when the profile is on but DEMO is not verified', () => {
      const loose = loadMt5RiskSettings({ FAST_LEARNING_RISK_PROFILE: 'true' });
      const guarded = effectiveMt5RiskSettings(false, loose);
      expect(guarded.mt5_max_simultaneous_positions).toBe(3);
      expect(guarded.mt5_max_trades_per_day).toBe(6);
      expect(guarded.mt5_max_risk_per_trade_pct).toBe('0.50');
      expect(guarded.mt5_max_loss_per_trade).toBe('100.00');
    });

    it('effectiveMt5RiskSettings passes the loosened limits through once DEMO is verified', () => {
      const loose = loadMt5RiskSettings({ FAST_LEARNING_RISK_PROFILE: 'true' });
      const verified = effectiveMt5RiskSettings(true, loose);
      expect(verified.mt5_max_simultaneous_positions).toBe(10);
      expect(verified.mt5_max_trades_per_day).toBe(30);
      expect(verified.mt5_max_risk_per_trade_pct).toBe('1.0');
      expect(verified.mt5_max_loss_per_trade).toBe('3.00');
    });

    it('effectiveMt5RiskSettings is a no-op when the profile is off, verified or not', () => {
      const strict = loadMt5RiskSettings({});
      expect(effectiveMt5RiskSettings(false, strict)).toEqual(strict);
      expect(effectiveMt5RiskSettings(true, strict)).toEqual(strict);
    });
  });
});
