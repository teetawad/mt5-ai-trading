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

  // DEMO Fast Learning risk profile fix: the position cap was too low (3) to
  // let FIND BEST TRADES ever place more than a couple of concurrent DEMO
  // trades, and the minimum-volume rule blocked trades whose real loss at SL
  // was well within the owner's own configured absolute cap. These tests
  // pin the exact scenarios from the bug report.
  describe('DEMO Fast Learning risk profile fixes', () => {
    const fastLearningSettings = {
      mt5_kill_switch_enabled: false,
      mt5_max_risk_per_trade_pct: '1.0',
      mt5_max_loss_per_trade: '3.00',
      mt5_min_risk_reward: '1.5',
      mt5_max_simultaneous_positions: 10,
      mt5_max_trades_per_day: 30,
      mt5_quote_staleness_seconds: 10,
      mt5_max_spread_points: 50,
      mt5_margin_safety_buffer_pct: '50',
    };
    const baseTrade = {
      decision: 'BUY' as const,
      referenceEntry: '100',
      stopLoss: '99',
      takeProfit: '102',
      riskReward: '2',
      confidence: 0.7,
      terminal: { trade_allowed: true },
      quoteAgeSeconds: 1,
      spreadPoints: 10,
      marketStatus: 'OPEN' as const,
      dataStatus: 'LIVE' as const,
      leverage: 500,
    };

    it('3 existing positions with max=10 does not trigger MAX_SIMULTANEOUS_POSITIONS', () => {
      const result = evaluateMt5Risk({
        ...baseTrade,
        account: { equity: '10000', margin_free: '9000' },
        settings: fastLearningSettings,
        openPositions: 3,
        tradesToday: 0,
        symbol: { contractSize: 1, tickSize: 1, tickValueLoss: 1, tickValueProfit: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 1 },
      });
      expect(result.failedRules).not.toContain('MAX_SIMULTANEOUS_POSITIONS');
    });

    it('10 existing positions with max=10 triggers MAX_SIMULTANEOUS_POSITIONS', () => {
      const result = evaluateMt5Risk({
        ...baseTrade,
        account: { equity: '10000', margin_free: '9000' },
        settings: fastLearningSettings,
        openPositions: 10,
        tradesToday: 0,
        symbol: { contractSize: 1, tickSize: 1, tickValueLoss: 1, tickValueProfit: 1, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 1 },
      });
      expect(result.failedRules).toContain('MAX_SIMULTANEOUS_POSITIONS');
    });

    it('allows the broker minimum lot when its real loss at SL ($2.10) is under the absolute max loss cap ($3.00), even though it exceeds the % risk budget', () => {
      // equity=$100, 1% risk budget = $1.00 — well below both the min-lot
      // loss ($2.10) and the $3.00 absolute cap, mirroring the spec's own
      // example: "calculated ideal lot = 0.006, broker minimum = 0.01, loss
      // at SL with 0.01 lot = US$2.10, FAST LEARNING max loss = US$3.00 ->
      // allow 0.01 lot."
      const result = evaluateMt5Risk({
        ...baseTrade,
        referenceEntry: '100',
        stopLoss: '79',
        takeProfit: '142',
        account: { equity: '100', margin_free: '100' },
        settings: fastLearningSettings,
        openPositions: 0,
        tradesToday: 0,
        // riskDistance=21, lossPerLot = 21/1*10 = $210/lot -> min lot
        // (0.01) loses $2.10, matching the spec's own worked example.
        symbol: { contractSize: 1, tickSize: 1, tickValueLoss: 10, tickValueProfit: 10, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 1 },
      });
      expect(result.result).toBe('PASS');
      expect(result.failedRules).not.toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
      expect(Number(result.recommendedVolume)).toBeCloseTo(0.01, 8);
      expect(Number(result.snapshot.expectedLossAtSl)).toBeCloseTo(2.1, 2);
      expect(Number(result.snapshot.expectedLossAtSl)).toBeLessThanOrEqual(3.0);
    });

    it('still blocks with MINIMUM_VOLUME_EXCEEDS_RISK when even the broker minimum lot would lose more than the absolute max loss cap', () => {
      const result = evaluateMt5Risk({
        ...baseTrade,
        referenceEntry: '100',
        stopLoss: '50',
        takeProfit: '200',
        account: { equity: '300', margin_free: '300' },
        settings: fastLearningSettings,
        openPositions: 0,
        tradesToday: 0,
        symbol: { contractSize: 100000, tickSize: 1, tickValueLoss: 1000, tickValueProfit: 1000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, point: 1 },
      });
      expect(result.result).toBe('REJECT');
      expect(result.failedRules).toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
      expect(Number(result.recommendedVolume)).toBe(0);
    });

    it('insufficient margin is always a hard block, even under loosened Fast Learning DEMO settings', () => {
      const result = evaluateMt5Risk({
        ...baseTrade,
        referenceEntry: '2000',
        stopLoss: '1998',
        takeProfit: '2020',
        account: { equity: '10000', margin_free: '1000' },
        settings: fastLearningSettings,
        openPositions: 0,
        tradesToday: 0,
        // riskBudget=$3.00, lossPerLot=$200/lot -> a valid 0.01 lot is sized
        // (never hits MINIMUM_VOLUME_EXCEEDS_RISK), but leverage=1 makes
        // even that lot require $2000 margin, far above the 50% safety
        // buffer on $1000 free margin ($500) — always blocked regardless of
        // how loose the risk %/loss caps are.
        leverage: 1,
        symbol: { contractSize: 100, tickSize: 0.01, tickValueLoss: 1, tickValueProfit: 1, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, point: 0.01 },
      });
      expect(result.result).toBe('REJECT');
      expect(result.failedRules).toContain('INSUFFICIENT_MARGIN');
      expect(result.failedRules).not.toContain('MINIMUM_VOLUME_EXCEEDS_RISK');
      expect(Number(result.snapshot.marginShortfall)).toBeGreaterThan(0);
    });
  });

  // Quality-based DEMO sizing (spec sections 12, 32): demo-sizing.ts's
  // applyQualityBasedSizing substitutes the quality tier's own absolute max
  // loss for mt5_max_loss_per_trade and re-runs this SAME risk engine — so
  // the tier cap is provably just one more input to the existing "smaller of
  // % risk budget vs. absolute cap" sizing logic, never a separate/weaker
  // code path.
  describe('quality-based DEMO sizing tiers', () => {
    const tierTrade = {
      decision: 'BUY' as const,
      referenceEntry: '100',
      stopLoss: '90',
      takeProfit: '120',
      riskReward: '2',
      confidence: 0.7,
      account: { equity: '100000', margin_free: '100000' },
      terminal: { trade_allowed: true },
      openPositions: 0,
      tradesToday: 0,
      quoteAgeSeconds: 1,
      spreadPoints: 10,
      marketStatus: 'OPEN' as const,
      dataStatus: 'LIVE' as const,
      leverage: 500,
      symbol: { contractSize: 1, tickSize: 1, tickValueLoss: 1, tickValueProfit: 1, volumeMin: 0.01, volumeMax: 1000, volumeStep: 0.01, point: 1 },
    };

    it('Final Quality 70 (NORMAL tier): sizes so expected loss at SL never exceeds the $3.00 tier cap', () => {
      const result = evaluateMt5Risk({
        ...tierTrade,
        settings: { mt5_kill_switch_enabled: false, mt5_max_risk_per_trade_pct: '100', mt5_max_loss_per_trade: '3.00', mt5_min_risk_reward: '1.5', mt5_max_simultaneous_positions: 10, mt5_max_trades_per_day: 30, mt5_quote_staleness_seconds: 10, mt5_max_spread_points: 50 },
      });
      expect(result.result).toBe('PASS');
      expect(Number(result.snapshot.expectedLossAtSl)).toBeLessThanOrEqual(3.0);
    });

    it('Final Quality 85 (HIGH tier): sizes so expected loss at SL never exceeds the $4.50 tier cap', () => {
      const result = evaluateMt5Risk({
        ...tierTrade,
        settings: { mt5_kill_switch_enabled: false, mt5_max_risk_per_trade_pct: '100', mt5_max_loss_per_trade: '4.50', mt5_min_risk_reward: '1.5', mt5_max_simultaneous_positions: 10, mt5_max_trades_per_day: 30, mt5_quote_staleness_seconds: 10, mt5_max_spread_points: 50 },
      });
      expect(result.result).toBe('PASS');
      expect(Number(result.snapshot.expectedLossAtSl)).toBeLessThanOrEqual(4.5);
    });

    it('the tier cap never overrides the account %-risk floor — the smaller of the two always wins', () => {
      const result = evaluateMt5Risk({
        ...tierTrade,
        account: { equity: '100', margin_free: '100' }, // 1% of $100 = $1.00, well under the $4.50 HIGH tier cap
        settings: { mt5_kill_switch_enabled: false, mt5_max_risk_per_trade_pct: '1', mt5_max_loss_per_trade: '4.50', mt5_min_risk_reward: '1.5', mt5_max_simultaneous_positions: 10, mt5_max_trades_per_day: 30, mt5_quote_staleness_seconds: 10, mt5_max_spread_points: 50 },
      });
      // Sized to the tighter 1%-of-equity budget ($1.00), never up to the
      // $4.50 HIGH tier cap — proving the tier cap is only an upper bound,
      // never a floor that overrides a tighter account-level limit.
      expect(result.result).toBe('PASS');
      expect(Number(result.snapshot.expectedLossAtSl)).toBeLessThanOrEqual(1.0);
      expect(Number(result.snapshot.expectedLossAtSl)).toBeLessThan(4.5);
    });
  });
});
