import { describe, expect, it } from 'vitest';
import { atr, Bar, ema, lastFinite, macd, recentHighLow, rsi, sma, supportResistanceCandidates, trendFromMovingAverages } from '../services/trading-ai/indicators';

function bars(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 3600,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
  }));
}

describe('Trading AI indicators', () => {
  it('sma returns null before the window fills, then the correct average', () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBe(2);
    expect(result[4]).toBe(4);
  });

  it('ema seeds from an sma window and then reacts to new values', () => {
    const result = ema([1, 2, 3, 4, 5, 100], 3);
    expect(result[1]).toBeNull();
    expect(result[2]).toBe(2);
    expect(lastFinite(result)).toBeGreaterThan(4);
  });

  it('rsi is 100 for a strictly rising series and near 0 for a strictly falling one', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    const falling = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(rising, 14)).toBe(100);
    expect(rsi(falling, 14)).toBe(0);
  });

  it('rsi returns null when there is not enough history', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('atr is positive for a volatile series', () => {
    const value = atr(bars([100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106, 94, 107, 93]), 14);
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThan(0);
  });

  it('macd returns nulls when there is insufficient history', () => {
    const result = macd([1, 2, 3], 12, 26, 9);
    expect(result.macd).toBeNull();
    expect(result.signal).toBeNull();
  });

  it('recentHighLow finds the max/min over the lookback window', () => {
    const { high, low } = recentHighLow(bars([100, 105, 95, 110, 90]), 5);
    expect(high).toBe(110.2);
    expect(low).toBe(89.8);
  });

  it('supportResistanceCandidates returns a bounded, sorted list', () => {
    const closes = [100, 102, 98, 104, 96, 106, 94, 108, 92, 110, 90, 108, 92, 106, 94];
    const levels = supportResistanceCandidates(bars(closes), 3, 4);
    expect(levels.length).toBeLessThanOrEqual(4);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('trendFromMovingAverages classifies bullish/bearish/range/unclear', () => {
    expect(trendFromMovingAverages(110, 100, 111)).toBe('BULLISH');
    expect(trendFromMovingAverages(90, 100, 89)).toBe('BEARISH');
    expect(trendFromMovingAverages(100, 100.01, 100)).toBe('RANGE');
    expect(trendFromMovingAverages(null, 100, 100)).toBe('UNCLEAR');
  });
});
