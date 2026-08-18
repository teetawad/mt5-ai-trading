import { describe, expect, it } from 'vitest';
import { computeTradeScore, tradeRatingFor } from '../services/trading-ai/trade-score';
import { MarketAnalysisPackage, TimeframeSnapshot, TradeAIPlan } from '../services/trading-ai/types';

function timeframe(overrides: Partial<TimeframeSnapshot> = {}): TimeframeSnapshot {
  return {
    timeframe: 'H1',
    barCount: 220,
    lastClosedTime: new Date().toISOString(),
    open: 100, high: 101, low: 99, close: 100.5,
    tickVolume: 1000,
    sma20: 100, sma50: 99,
    ema20: 100.3, ema50: 99.5,
    rsi14: 60,
    atr14: 0.5,
    macd: 0.02, macdSignal: 0.01, macdHistogram: 0.01,
    recentHigh: 101, recentLow: 98,
    supportResistance: [98.5, 101.5],
    trend: 'BULLISH',
    ...overrides,
  };
}

function pkg(overrides: Partial<MarketAnalysisPackage> = {}): MarketAnalysisPackage {
  return {
    symbol: 'XAUUSD',
    assetClass: 'METAL',
    generatedAt: new Date().toISOString(),
    quote: { bid: 100.4, ask: 100.5, spread: 0.1, digits: 2, point: 0.01, quoteAgeSeconds: 1 },
    market: { status: 'CONNECTED', dataStatus: 'LIVE', sessionOpen: null, sessionClose: null, nextOpen: null },
    timeframes: [
      timeframe({ timeframe: 'M15', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H1', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ],
    account: { balance: 10000, equity: 10000, freeMargin: 9000, currency: 'USD' },
    existingPosition: { exists: false },
    existingPendingOrder: { exists: false },
    ...overrides,
  };
}

function plan(overrides: Partial<TradeAIPlan> = {}): TradeAIPlan {
  return {
    symbol: 'XAUUSD',
    asset_class: 'METAL',
    decision: 'BUY',
    confidence_pct: 76,
    tradeability_pct: 70,
    profitability_score: 65,
    market_condition: 'trending bullish',
    trend: 'BULLISH',
    entry_type: 'MARKET_NOW',
    current_price: 100.5,
    entry_price: 100.5,
    entry_zone_low: null,
    entry_zone_high: null,
    trigger_price: null,
    pending_order_type: 'NONE',
    stop_loss: 99.8,
    take_profit: 101.9,
    risk_reward: 2,
    lot_size_suggestion: 0.01,
    expected_holding_minutes: 120,
    plan_expiry_minutes: 60,
    invalidation_reason: null,
    reason_summary: 'Bullish continuation setup',
    reason_details: ['H1/H4 trend bullish', 'momentum positive'],
    risks: [],
    ...overrides,
  };
}

describe('Trade Score', () => {
  it('returns null for a WAIT decision — there is no plan to score', () => {
    expect(computeTradeScore(pkg(), plan({ decision: 'WAIT', entry_type: 'NO_ENTRY', stop_loss: null, take_profit: null, risk_reward: null }))).toBeNull();
  });

  it('is computed independently of AI confidence: high confidence does not force a high score', () => {
    const neutralMomentumPkg = pkg({
      timeframes: [
        timeframe({ timeframe: 'M15', trend: 'BULLISH', rsi14: 50, macdHistogram: 0 }),
        timeframe({ timeframe: 'H1', trend: 'BULLISH', rsi14: 50, macdHistogram: 0 }),
        timeframe({ timeframe: 'H4', trend: 'BULLISH', rsi14: 50, macdHistogram: 0 }),
      ],
    });
    const weakSetup = plan({
      confidence_pct: 95, // AI is very sure about its read...
      risk_reward: 1, // ...but the setup itself is poor quality.
      entry_price: 110, // far from current price (100.5) relative to ATR 0.5
    });
    const result = computeTradeScore(neutralMomentumPkg, weakSetup)!;
    expect(result.tradeScore).toBeLessThan(75);
    expect(weakSetup.confidence_pct).toBe(95);
    expect(result.tradeScore).not.toBe(weakSetup.confidence_pct);
  });

  it('produces a high score for a strong, well-aligned setup', () => {
    const result = computeTradeScore(pkg(), plan())!;
    expect(result.tradeScore).toBeGreaterThanOrEqual(75);
    expect(result.tradeRating).toMatch(/GOOD|STRONG/);
  });

  it('a genuinely weak setup (bad R:R, opposing trend, extended entry) rates AVOID or WEAK', () => {
    const badPkg = pkg({
      timeframes: [
        timeframe({ timeframe: 'M15', trend: 'BEARISH' }),
        timeframe({ timeframe: 'H1', trend: 'BEARISH', rsi14: 30, macdHistogram: -0.02 }),
        timeframe({ timeframe: 'H4', trend: 'BEARISH' }),
      ],
    });
    const result = computeTradeScore(badPkg, plan({ risk_reward: 0.8, entry_price: 115 }))!;
    expect(result.tradeScore).toBeLessThan(60);
    expect(['AVOID', 'WEAK']).toContain(result.tradeRating);
  });

  it('a PULLBACK/BREAKOUT plan still waiting for its entry can score highly ("good setup, wrong price yet")', () => {
    const result = computeTradeScore(pkg(), plan({
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      entry_price: null, entry_zone_low: 99.9, entry_zone_high: 100.1,
    }))!;
    expect(result.tradeScore).toBeGreaterThanOrEqual(60);
  });

  it('the breakdown always sums to the total trade score', () => {
    const result = computeTradeScore(pkg(), plan())!;
    const sum = result.breakdown.trend + result.breakdown.momentum + result.breakdown.entryQuality
      + result.breakdown.riskReward + result.breakdown.marketConditions;
    expect(sum).toBe(result.tradeScore);
  });

  it('every breakdown dimension stays within its 0-20 bound', () => {
    const result = computeTradeScore(pkg(), plan())!;
    for (const value of Object.values(result.breakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it('tradeRatingFor maps score bands correctly, including the AVOID/STRONG boundaries', () => {
    expect(tradeRatingFor(0)).toBe('AVOID');
    expect(tradeRatingFor(39)).toBe('AVOID');
    expect(tradeRatingFor(40)).toBe('WEAK');
    expect(tradeRatingFor(59)).toBe('WEAK');
    expect(tradeRatingFor(60)).toBe('FAIR');
    expect(tradeRatingFor(74)).toBe('FAIR');
    expect(tradeRatingFor(75)).toBe('GOOD');
    expect(tradeRatingFor(89)).toBe('GOOD');
    expect(tradeRatingFor(90)).toBe('STRONG');
    expect(tradeRatingFor(100)).toBe('STRONG');
  });

  it('rewards a strong risk/reward ratio and penalizes a weak one', () => {
    const strong = computeTradeScore(pkg(), plan({ risk_reward: 3 }))!;
    const weak = computeTradeScore(pkg(), plan({ risk_reward: 1 }))!;
    expect(strong.breakdown.riskReward).toBeGreaterThan(weak.breakdown.riskReward);
  });

  it('penalizes a stale quote and a wide spread in market conditions', () => {
    const fresh = computeTradeScore(pkg(), plan())!;
    const stale = computeTradeScore(pkg({ quote: { bid: 100.4, ask: 100.5, spread: 0.6, digits: 2, point: 0.01, quoteAgeSeconds: 45 } }), plan())!;
    expect(stale.breakdown.marketConditions).toBeLessThan(fresh.breakdown.marketConditions);
  });
});
