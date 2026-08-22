import { describe, expect, it } from 'vitest';
import { computeMultiTimeframeAlignmentScore } from '../services/trading-ai/multi-timeframe-alignment';
import { MarketAnalysisPackage, TimeframeSnapshot } from '../services/trading-ai/types';

function pkgWithTrends(trends: Record<TimeframeSnapshot['timeframe'], TimeframeSnapshot['trend']>): MarketAnalysisPackage {
  const base: Omit<TimeframeSnapshot, 'timeframe' | 'trend'> = {
    barCount: 220, lastClosedTime: null, open: 1, high: 1.01, low: 0.99, close: 1, tickVolume: 100,
    sma20: 1, sma50: 1, ema20: 1, ema50: 1, rsi14: 55, atr14: 0.001, macd: 0, macdSignal: 0, macdHistogram: 0,
    recentHigh: 1.02, recentLow: 0.98, supportResistance: [],
  };
  return {
    symbol: 'TEST', assetClass: 'FOREX', generatedAt: new Date().toISOString(),
    quote: { bid: 1, ask: 1.0001, spread: 0.0001, digits: 5, point: 0.00001, quoteAgeSeconds: 1 },
    market: { status: 'OPEN', dataStatus: 'LIVE', sessionOpen: null, sessionClose: null, nextOpen: null },
    timeframes: (['M5', 'M15', 'H1', 'H4'] as const).map((tf) => ({ ...base, timeframe: tf, trend: trends[tf] })),
    account: { balance: 1000, equity: 1000, freeMargin: 1000, currency: 'USD' },
    existingPosition: { exists: false },
    existingPendingOrder: { exists: false },
  };
}

describe('computeMultiTimeframeAlignmentScore', () => {
  it('scores 100 when every timeframe agrees with the decision direction (spec example: M5/M15/H1/H4 all BUY)', () => {
    const pkg = pkgWithTrends({ M5: 'BULLISH', M15: 'BULLISH', H1: 'BULLISH', H4: 'BULLISH' });
    const result = computeMultiTimeframeAlignmentScore(pkg, 'BUY');
    expect(result.score).toBe(100);
  });

  it('scores significantly lower — but not zero — when higher timeframes oppose the entry timeframes (spec example: M5/M15 BUY vs H1/H4 SELL)', () => {
    const pkg = pkgWithTrends({ M5: 'BULLISH', M15: 'BULLISH', H1: 'BEARISH', H4: 'BEARISH' });
    const result = computeMultiTimeframeAlignmentScore(pkg, 'BUY');
    expect(result.score).toBeLessThan(60);
    expect(result.score).toBeGreaterThan(0);
  });

  it('never hard-rejects a counter-trend setup — a fully opposed setup still returns a valid, non-negative score', () => {
    const pkg = pkgWithTrends({ M5: 'BEARISH', M15: 'BEARISH', H1: 'BEARISH', H4: 'BEARISH' });
    const result = computeMultiTimeframeAlignmentScore(pkg, 'BUY');
    expect(result.score).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('treats RANGE/UNCLEAR timeframes as neutral, not opposing', () => {
    const rangeAll = pkgWithTrends({ M5: 'RANGE', M15: 'RANGE', H1: 'RANGE', H4: 'RANGE' });
    const result = computeMultiTimeframeAlignmentScore(rangeAll, 'BUY');
    expect(result.score).toBe(50);
  });
});
