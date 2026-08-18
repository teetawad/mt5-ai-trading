import { describe, expect, it } from 'vitest';
import { computeShortlistScore } from '../services/trading-ai/shortlist-score';
import { MarketAnalysisPackage, TimeframeSnapshot } from '../services/trading-ai/types';

function timeframe(overrides: Partial<TimeframeSnapshot> = {}): TimeframeSnapshot {
  return {
    timeframe: 'H1', barCount: 220, lastClosedTime: null,
    open: 100, high: 101, low: 99, close: 100.5, tickVolume: 1000,
    sma20: null, sma50: null, ema20: null, ema50: null,
    rsi14: null, atr14: null, macd: null, macdSignal: null, macdHistogram: null,
    recentHigh: null, recentLow: null, supportResistance: [],
    trend: 'UNCLEAR',
    ...overrides,
  };
}

function pkg(overrides: Partial<MarketAnalysisPackage> = {}, timeframes: TimeframeSnapshot[] = []): MarketAnalysisPackage {
  return {
    symbol: 'TEST', assetClass: 'FOREX', generatedAt: '',
    quote: { bid: 100, ask: 100.1, spread: 0.1, digits: 2, point: 0.01, quoteAgeSeconds: 1 },
    market: { status: 'CONNECTED', dataStatus: 'LIVE', sessionOpen: null, sessionClose: null, nextOpen: null },
    timeframes,
    account: { balance: null, equity: null, freeMargin: null, currency: null },
    existingPosition: { exists: false },
    existingPendingOrder: { exists: false },
    ...overrides,
  };
}

describe('computeShortlistScore', () => {
  it('returns 0 with no usable data at all', () => {
    const result = computeShortlistScore(pkg({ quote: { bid: null, ask: null, spread: null, digits: null, point: null, quoteAgeSeconds: null } }, []));
    expect(result.score).toBe(0);
  });

  it('rewards H1/H4 trend alignment (both BULLISH) over no alignment', () => {
    const aligned = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    const unaligned = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H4', trend: 'BEARISH' }),
    ]));
    expect(aligned.breakdown.trendAlignment).toBe(30);
    expect(unaligned.breakdown.trendAlignment).toBeLessThan(30);
    expect(aligned.score).toBeGreaterThan(unaligned.score);
  });

  it('never scores RANGE/RANGE alignment as directional', () => {
    const result = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'RANGE' }),
      timeframe({ timeframe: 'H4', trend: 'RANGE' }),
    ]));
    expect(result.breakdown.trendAlignment).toBe(0);
  });

  it('rewards a healthy (non-exhausted) RSI matching trend direction', () => {
    const healthy = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'BULLISH', rsi14: 60 }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    const overbought = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'BULLISH', rsi14: 95 }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    expect(healthy.breakdown.momentum).toBeGreaterThan(overbought.breakdown.momentum);
  });

  it('penalizes a wide spread relative to ATR', () => {
    const tight = computeShortlistScore(pkg({ quote: { bid: 100, ask: 100.01, spread: 0.01, digits: 2, point: 0.01, quoteAgeSeconds: 1 } }, [
      timeframe({ timeframe: 'H1', atr14: 1 }),
      timeframe({ timeframe: 'H4', atr14: 1 }),
    ]));
    const wide = computeShortlistScore(pkg({ quote: { bid: 100, ask: 100.5, spread: 0.5, digits: 2, point: 0.01, quoteAgeSeconds: 1 } }, [
      timeframe({ timeframe: 'H1', atr14: 1 }),
      timeframe({ timeframe: 'H4', atr14: 1 }),
    ]));
    expect(tight.breakdown.volatilityQuality).toBeGreaterThan(wide.breakdown.volatilityQuality);
  });

  it('penalizes a stale quote versus a fresh one', () => {
    const fresh = computeShortlistScore(pkg({ quote: { bid: 100, ask: 100.1, spread: 0.1, digits: 2, point: 0.01, quoteAgeSeconds: 2 } }, []));
    const stale = computeShortlistScore(pkg({ quote: { bid: 100, ask: 100.1, spread: 0.1, digits: 2, point: 0.01, quoteAgeSeconds: 90 } }, []));
    expect(fresh.breakdown.volatilityQuality).toBeGreaterThan(stale.breakdown.volatilityQuality);
  });

  it('rewards price sitting near a real recent support/resistance level', () => {
    const near = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', close: 100, atr14: 1, supportResistance: [100.5] }),
    ]));
    const far = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', close: 100, atr14: 1, supportResistance: [130] }),
    ]));
    expect(near.breakdown.structure).toBeGreaterThan(far.breakdown.structure);
  });

  it('never returns a negative score or a score above 100', () => {
    const result = computeShortlistScore(pkg({}, [
      timeframe({ timeframe: 'H1', trend: 'BULLISH', rsi14: 60, macdHistogram: 0.01, atr14: 1, supportResistance: [100.2], close: 100 }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
