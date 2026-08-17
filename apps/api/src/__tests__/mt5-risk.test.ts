import { describe, expect, it } from 'vitest';
import { evaluateMt5Risk, normalizeVolume } from '../services/mt5-risk-engine';
import Decimal from 'decimal.js';

describe('MT5 risk engine', () => {
  const settings = {
    mt5_kill_switch_enabled: false,
    mt5_max_risk_per_trade_pct: '1',
    mt5_max_loss_per_trade: '100',
    mt5_min_risk_reward: '1.5',
    mt5_max_simultaneous_positions: 3,
    mt5_max_trades_per_day: 5,
    mt5_quote_staleness_seconds: 10,
    mt5_max_spread_points: 50,
  };

  it('sizes volume from monetary risk and stop distance', () => {
    expect(normalizeVolume(new Decimal('10.129'), new Decimal('0.01'), new Decimal('100'), new Decimal('0.01')).toString()).toBe('10.12');
  });

  it('passes a complete demo trade structure', () => {
    const result = evaluateMt5Risk({
      decision: 'BUY',
      referenceEntry: '100',
      stopLoss: '99',
      takeProfit: '102',
      riskReward: '2',
      confidence: 0.7,
      account: { equity: '10000', margin_free: '5000' },
      terminal: { trade_allowed: true },
      settings,
      openPositions: 0,
      tradesToday: 0,
      quoteAgeSeconds: 1,
      spreadPoints: 10,
    });
    expect(result.result).toBe('PASS');
    expect(result.recommendedVolume).toBe('100.00000000');
  });

  it('rejects kill switch, missing SL/TP, stale quotes, and poor R:R', () => {
    const result = evaluateMt5Risk({
      decision: 'BUY',
      referenceEntry: '100',
      stopLoss: null,
      takeProfit: null,
      riskReward: '1',
      confidence: 0.9,
      account: { equity: '10000', margin_free: '5000' },
      terminal: { trade_allowed: true },
      settings: { ...settings, mt5_kill_switch_enabled: true },
      openPositions: 0,
      tradesToday: 0,
      quoteAgeSeconds: 99,
      spreadPoints: 100,
    });
    expect(result.result).toBe('REJECT');
    expect(result.failedRules).toContain('SAFETY_SWITCH_ON');
    expect(result.failedRules).toContain('STOP_LOSS_REQUIRED');
    expect(result.failedRules).toContain('TAKE_PROFIT_REQUIRED');
    expect(result.failedRules).toContain('STALE_QUOTE');
    expect(result.failedRules).toContain('SPREAD_TOO_HIGH');
  });

  it('rejects non-open markets and non-live data independently', () => {
    const result = evaluateMt5Risk({
      decision: 'BUY',
      referenceEntry: '100',
      stopLoss: '99',
      takeProfit: '102',
      riskReward: '2',
      confidence: 0.9,
      account: { equity: '10000', margin_free: '5000' },
      terminal: { trade_allowed: true },
      settings,
      openPositions: 0,
      tradesToday: 0,
      marketStatus: 'CLOSED',
      dataStatus: 'STALE',
    });
    expect(result.result).toBe('REJECT');
    expect(result.failedRules).toContain('MARKET_CLOSED');
    expect(result.failedRules).toContain('STALE_DATA');
  });

  it('does not fail with SAFETY_SWITCH_ON when kill switch is off', () => {
    const result = evaluateMt5Risk({
      decision: 'BUY',
      referenceEntry: '100',
      stopLoss: '99',
      takeProfit: '102',
      riskReward: '2',
      confidence: 0.7,
      account: { equity: '300', margin_free: '300' },
      terminal: { trade_allowed: true },
      settings: { ...settings, mt5_kill_switch_enabled: false, mt5_max_loss_per_trade: '2.00', mt5_max_risk_per_trade_pct: '0.50' },
      openPositions: 0,
      tradesToday: 0,
      quoteAgeSeconds: 1,
      spreadPoints: 10,
      marketStatus: 'OPEN',
      dataStatus: 'LIVE',
    });
    expect(result.failedRules).not.toContain('SAFETY_SWITCH_ON');
  });

  it('blocks with SAFETY_SWITCH_ON when kill switch is on', () => {
    const result = evaluateMt5Risk({
      decision: 'BUY',
      referenceEntry: '100',
      stopLoss: '99',
      takeProfit: '102',
      riskReward: '2',
      confidence: 0.7,
      account: { equity: '300', margin_free: '300' },
      terminal: { trade_allowed: true },
      settings: { ...settings, mt5_kill_switch_enabled: true },
      openPositions: 0,
      tradesToday: 0,
      quoteAgeSeconds: 1,
      spreadPoints: 10,
      marketStatus: 'OPEN',
      dataStatus: 'LIVE',
    });
    expect(result.failedRules).toContain('SAFETY_SWITCH_ON');
  });
});
