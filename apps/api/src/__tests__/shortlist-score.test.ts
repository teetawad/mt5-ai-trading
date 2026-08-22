import { describe, expect, it } from 'vitest';
import { computeM5ShortlistScore, computeShortlistScore } from '../services/trading-ai/shortlist-score';
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

// M5 Fast Learning's own shortlist score (spec section 2): M5 (entry timing)
// and M15 (setup structure) must dominate the weighting, unlike
// computeShortlistScore's H1/H4-centric weighting used by the manual scanner.
describe('computeM5ShortlistScore', () => {
  it('returns 0 with no usable data at all', () => {
    const result = computeM5ShortlistScore(pkg({ quote: { bid: null, ask: null, spread: null, digits: null, point: null, quoteAgeSeconds: null } }, []));
    expect(result.score).toBe(0);
  });

  it('rewards a healthy M5 RSI/MACD entry-timing setup over a flat one', () => {
    const strong = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH', rsi14: 60, macdHistogram: 0.01 }),
    ]));
    const weak = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'UNCLEAR', rsi14: null, macdHistogram: null }),
    ]));
    expect(strong.breakdown.m5EntryTiming).toBeGreaterThan(weak.breakdown.m5EntryTiming);
  });

  it('penalizes a spread that dominates M5 ATR more heavily than a wide-but-tolerable spread', () => {
    const tight = computeM5ShortlistScore(pkg({ quote: { bid: 100, ask: 100.01, spread: 0.01, digits: 2, point: 0.01, quoteAgeSeconds: 1 } }, [
      timeframe({ timeframe: 'M5', atr14: 1 }),
    ]));
    const wide = computeM5ShortlistScore(pkg({ quote: { bid: 100, ask: 100.5, spread: 0.5, digits: 2, point: 0.01, quoteAgeSeconds: 1 } }, [
      timeframe({ timeframe: 'M5', atr14: 1 }),
    ]));
    expect(tight.breakdown.m5EntryTiming).toBeGreaterThan(wide.breakdown.m5EntryTiming);
  });

  it('rewards M5 price sitting near a real recent M15 support/resistance level', () => {
    const near = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M15', close: 100, atr14: 1, supportResistance: [100.5] }),
    ]));
    const far = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M15', close: 100, atr14: 1, supportResistance: [130] }),
    ]));
    expect(near.breakdown.m15Structure).toBeGreaterThan(far.breakdown.m15Structure);
  });

  it('rewards M5/M15 trend agreement (entry timing confirms the setup) over disagreement', () => {
    const agree = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH' }),
      timeframe({ timeframe: 'M15', trend: 'BULLISH' }),
    ]));
    const disagree = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH' }),
      timeframe({ timeframe: 'M15', trend: 'BEARISH' }),
    ]));
    expect(agree.breakdown.m5m15Alignment).toBeGreaterThan(disagree.breakdown.m5m15Alignment);
  });

  it('still considers H1/H4 as a smaller context factor — never removes higher timeframes', () => {
    const withContext = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH', rsi14: 60, macdHistogram: 0.01, atr14: 1 }),
      timeframe({ timeframe: 'M15', trend: 'BULLISH', close: 100, atr14: 1, supportResistance: [100.2] }),
      timeframe({ timeframe: 'H1', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    const withoutContext = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH', rsi14: 60, macdHistogram: 0.01, atr14: 1 }),
      timeframe({ timeframe: 'M15', trend: 'BULLISH', close: 100, atr14: 1, supportResistance: [100.2] }),
    ]));
    // H1/H4 context is still a real, present factor...
    expect(withContext.breakdown.higherTimeframeContext).toBeGreaterThan(withoutContext.breakdown.higherTimeframeContext);
    expect(withContext.score).toBeGreaterThan(withoutContext.score);
    // ...but deliberately a smaller share of the total than M5 entry timing +
    // M15 structure combined (spec section 2: M5 is the execution timeframe).
    expect(withContext.breakdown.higherTimeframeContext).toBeLessThan(withContext.breakdown.m5EntryTiming + withContext.breakdown.m15Structure);
  });

  it('never returns a negative score or a score above 100', () => {
    const result = computeM5ShortlistScore(pkg({}, [
      timeframe({ timeframe: 'M5', trend: 'BULLISH', rsi14: 60, macdHistogram: 0.01, atr14: 1 }),
      timeframe({ timeframe: 'M15', trend: 'BULLISH', close: 100, atr14: 1, supportResistance: [100.2] }),
      timeframe({ timeframe: 'H1', trend: 'BULLISH' }),
      timeframe({ timeframe: 'H4', trend: 'BULLISH' }),
    ]));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
