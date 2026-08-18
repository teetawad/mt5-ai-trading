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
    // contract_size=1, tick_value==tick_size makes the broker-aware loss
    // calc numerically equal to a plain price-difference-per-lot here — the
    // "provably correct for this symbol" case, not a coincidence.
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
      symbol: { contractSize: 1, tickSize: 1, tickValueLoss: 1, tickValueProfit: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 1 },
      leverage: 500,
    });
    expect(result.result).toBe('PASS');
    expect(result.recommendedVolume).toBe('100.00000000');
  });

  it('rejects (never guesses) when symbol economics are unavailable, even though everything else is fine', () => {
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
      // no `symbol` provided
    });
    expect(result.result).toBe('REJECT');
    expect(result.failedRules).toContain('SYMBOL_INFO_UNAVAILABLE');
    expect(Number(result.recommendedVolume)).toBe(0);
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

  describe('broker-native position sizing', () => {
    const beginnerSettings = {
      ...settings,
      mt5_kill_switch_enabled: false,
      mt5_max_loss_per_trade: '2.00',
      mt5_max_risk_per_trade_pct: '0.50',
      mt5_margin_safety_buffer_pct: '50',
    };

    it('reproduces the reported AUDZAR bug: a forex cross whose minimum lot already exceeds a $300 account\'s risk budget is BLOCKED, not sized to 44 lots', () => {
      // Representative AUDZAR-like economics: a 0.05 price move (a realistic
      // stop distance for this pair) costs $300 per 1.0 lot at this tick
      // value, not the ~$0.03/lot the old naive price-difference calc
      // implied. On a $300 account with a $1.50 risk budget, even the
      // broker's minimum 0.01 lot ($3.00 potential loss) already exceeds
      // the budget, so the correct answer is BLOCK, never a fabricated
      // 44.38 lot recommendation.
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '13.200',
        stopLoss: '13.150',
        takeProfit: '13.300',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '300', margin_free: '300' },
        terminal: { trade_allowed: true },
        settings: beginnerSettings,
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 100000,
          tickSize: 0.0001,
          tickValueLoss: 0.6,
          tickValueProfit: 0.6,
          volumeMin: 0.01,
          volumeMax: 100,
          volumeStep: 0.01,
          point: 0.00001,
        },
        leverage: 500,
      });
      expect(result.result).toBe('REJECT');
      expect(result.failedRules).toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
      expect(Number(result.recommendedVolume)).toBe(0);
      expect(Number(result.recommendedVolume)).not.toBeCloseTo(44.38, 1);
    });

    it('sizes a crypto symbol (small contract, tick value == tick size) to a small, valid lot', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '60000',
        stopLoss: '59940',
        takeProfit: '60120',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '300', margin_free: '300' },
        terminal: { trade_allowed: true },
        settings: beginnerSettings,
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 1,
          tickSize: 0.01,
          tickValueLoss: 0.01,
          tickValueProfit: 0.01,
          volumeMin: 0.01,
          volumeMax: 100,
          volumeStep: 0.01,
          point: 0.01,
        },
        leverage: 200,
      });
      expect(result.result).toBe('PASS');
      const volume = Number(result.recommendedVolume);
      expect(volume).toBeGreaterThanOrEqual(0.01);
      // loss at SL must never exceed the configured risk budget ($1.50 here)
      const expectedLoss = volume * 60 * 0.01;
      expect(expectedLoss).toBeLessThanOrEqual(1.5 + 1e-6);
    });

    it('sizes a metals symbol (100oz contract) correctly and passes margin validation', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '2000',
        stopLoss: '1990',
        takeProfit: '2020',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '10000', margin_free: '5000' },
        terminal: { trade_allowed: true },
        settings: { ...settings, mt5_kill_switch_enabled: false, mt5_max_loss_per_trade: '100', mt5_max_risk_per_trade_pct: '1', mt5_margin_safety_buffer_pct: '50' },
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 100,
          tickSize: 0.01,
          tickValueLoss: 1,
          tickValueProfit: 1,
          volumeMin: 0.01,
          volumeMax: 50,
          volumeStep: 0.01,
          point: 0.01,
        },
        leverage: 500,
      });
      expect(result.result).toBe('PASS');
      const volume = Number(result.recommendedVolume);
      // lossPerLot = 10 / 0.01 * 1 = $1000/lot; riskBudget = $100 -> ~0.10 lot
      expect(volume).toBeCloseTo(0.1, 2);
      const marginRequired = volume * 100 * 2000 / 500;
      const freeMargin = 5000;
      expect(marginRequired).toBeLessThanOrEqual(freeMargin * 0.5);
    });

    it('normalizes a raw volume that does not align to the broker volume_step', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '100',
        stopLoss: '99',
        takeProfit: '102',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '10000', margin_free: '9000' },
        terminal: { trade_allowed: true },
        settings: { ...settings, mt5_kill_switch_enabled: false, mt5_max_loss_per_trade: '253.4', mt5_max_risk_per_trade_pct: '100', mt5_margin_safety_buffer_pct: '90' },
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 1,
          tickSize: 1,
          tickValueLoss: 1,
          tickValueProfit: 1,
          volumeMin: 0.01,
          volumeMax: 100,
          volumeStep: 0.01,
          point: 1,
        },
        leverage: 500,
      });
      // rawVolume = 253.4 / 1 = 253.4, capped by volumeMax(100), aligned to
      // the 0.01 step regardless.
      const volume = Number(result.recommendedVolume);
      expect(Math.round(volume * 100)).toBe(volume * 100);
    });

    it('caps an enormous raw lot size at the broker volume_max instead of leaving it unbounded', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '100',
        stopLoss: '99.99',
        takeProfit: '102',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '1000000', margin_free: '900000' },
        terminal: { trade_allowed: true },
        settings: { ...settings, mt5_kill_switch_enabled: false, mt5_max_loss_per_trade: '500000', mt5_max_risk_per_trade_pct: '100', mt5_margin_safety_buffer_pct: '100' },
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 1,
          tickSize: 0.01,
          tickValueLoss: 0.01,
          tickValueProfit: 0.01,
          volumeMin: 0.01,
          volumeMax: 100,
          volumeStep: 0.01,
          point: 0.01,
        },
        leverage: 500,
      });
      expect(Number(result.recommendedVolume)).toBeLessThanOrEqual(100);
      expect(Number(result.recommendedVolume)).toBe(100);
    });

    it('blocks with INSUFFICIENT_MARGIN when the risk-sized volume would require more margin than the safety buffer allows', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '2000',
        stopLoss: '1990',
        takeProfit: '2020',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '10000', margin_free: '1000' },
        terminal: { trade_allowed: true },
        settings: { ...settings, mt5_kill_switch_enabled: false, mt5_max_loss_per_trade: '100', mt5_max_risk_per_trade_pct: '1', mt5_margin_safety_buffer_pct: '50' },
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 100,
          tickSize: 0.01,
          tickValueLoss: 1,
          tickValueProfit: 1,
          volumeMin: 0.01,
          volumeMax: 50,
          volumeStep: 0.01,
          point: 0.01,
        },
        // low leverage makes the same risk-valid 0.10 lot require $2000 margin,
        // far above the $500 (50% of $1000 free margin) safety allowance.
        leverage: 10,
      });
      expect(result.result).toBe('REJECT');
      expect(result.failedRules).toContain('INSUFFICIENT_MARGIN');
    });

    it('blocks with MINIMUM_VOLUME_EXCEEDS_RISK when even the broker minimum volume would lose more than the configured risk', () => {
      const result = evaluateMt5Risk({
        decision: 'BUY',
        referenceEntry: '100',
        stopLoss: '50',
        takeProfit: '200',
        riskReward: '2',
        confidence: 0.7,
        account: { equity: '300', margin_free: '300' },
        terminal: { trade_allowed: true },
        settings: beginnerSettings,
        openPositions: 0,
        tradesToday: 0,
        quoteAgeSeconds: 1,
        spreadPoints: 10,
        marketStatus: 'OPEN',
        dataStatus: 'LIVE',
        symbol: {
          contractSize: 100000,
          tickSize: 1,
          tickValueLoss: 1000,
          tickValueProfit: 1000,
          volumeMin: 0.01,
          volumeMax: 100,
          volumeStep: 0.01,
          point: 1,
        },
        leverage: 500,
      });
      expect(result.result).toBe('REJECT');
      expect(result.failedRules).toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
      expect(Number(result.recommendedVolume)).toBe(0);
    });
  });
});
