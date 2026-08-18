import { describe, expect, it } from 'vitest';
import { deriveTradeability, tradeabilityRatingFor } from '../services/trading-ai/tradeability';

describe('tradeabilityRatingFor', () => {
  it('bands: 85-100 STRONG, 70-84 GOOD, 50-69 FAIR, 30-49 LOW, 0-29 VERY_LOW', () => {
    expect(tradeabilityRatingFor(100)).toBe('STRONG');
    expect(tradeabilityRatingFor(85)).toBe('STRONG');
    expect(tradeabilityRatingFor(84)).toBe('GOOD');
    expect(tradeabilityRatingFor(70)).toBe('GOOD');
    expect(tradeabilityRatingFor(69)).toBe('FAIR');
    expect(tradeabilityRatingFor(50)).toBe('FAIR');
    expect(tradeabilityRatingFor(49)).toBe('LOW');
    expect(tradeabilityRatingFor(30)).toBe('LOW');
    expect(tradeabilityRatingFor(29)).toBe('VERY_LOW');
    expect(tradeabilityRatingFor(0)).toBe('VERY_LOW');
  });
});

describe('deriveTradeability', () => {
  it('rounds and clamps into [0, 100]', () => {
    expect(deriveTradeability(78.4).tradeabilityPct).toBe(78);
    expect(deriveTradeability(-5).tradeabilityPct).toBe(0);
    expect(deriveTradeability(150).tradeabilityPct).toBe(100);
  });

  it('95% -> STRONG, still just descriptive (not a gate)', () => {
    const result = deriveTradeability(95);
    expect(result).toEqual({ tradeabilityPct: 95, rating: 'STRONG', ratingLabelTh: 'น่าเทรดมาก' });
  });

  it('65% -> FAIR', () => {
    const result = deriveTradeability(65);
    expect(result.rating).toBe('FAIR');
    expect(result.ratingLabelTh).toBe('ปานกลาง');
  });

  it('42% -> LOW', () => {
    const result = deriveTradeability(42);
    expect(result.rating).toBe('LOW');
    expect(result.ratingLabelTh).toBe('ความน่าสนใจต่ำ');
  });

  it('12% -> VERY_LOW — still a valid, fully-formed result, never an error/gate', () => {
    const result = deriveTradeability(12);
    expect(result).toEqual({ tradeabilityPct: 12, rating: 'VERY_LOW', ratingLabelTh: 'คุณภาพต่ำ / เสี่ยงสูง' });
  });
});
