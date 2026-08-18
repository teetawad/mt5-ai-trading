import { describe, expect, it } from 'vitest';
import { formatConfidencePct } from './useConfidenceDisplay';

describe('formatConfidencePct', () => {
  it('renders the already-normalized 0-100 integer as a whole percent, with no re-scaling', () => {
    expect(formatConfidencePct(0)).toBe('0%');
    expect(formatConfidencePct(1)).toBe('1%');
    expect(formatConfidencePct(48)).toBe('48%');
    expect(formatConfidencePct(74)).toBe('74%');
    expect(formatConfidencePct(100)).toBe('100%');
  });

  it('never multiplies or divides — it is a pure passthrough formatter', () => {
    // Regression guard for the reported bug shape: if a fractional value ever
    // reached the frontend un-normalized, this proves the frontend does NOT
    // paper over it by multiplying by 100 (that transformation belongs only
    // in the backend's confidence.ts normalizer).
    expect(formatConfidencePct(0.74)).toBe('0.74%');
  });

  it('renders distinct values for BUY/SELL/WAIT decisions differently', () => {
    const buy = formatConfidencePct(91);
    const sell = formatConfidencePct(34);
    const wait = formatConfidencePct(65);
    expect(buy).toBe('91%');
    expect(sell).toBe('34%');
    expect(wait).toBe('65%');
    expect(new Set([buy, sell, wait]).size).toBe(3);
  });

  it('falls back to "-" for missing or non-finite values instead of showing a misleading percent', () => {
    expect(formatConfidencePct(null)).toBe('-');
    expect(formatConfidencePct(undefined)).toBe('-');
    expect(formatConfidencePct(NaN)).toBe('-');
  });
});
