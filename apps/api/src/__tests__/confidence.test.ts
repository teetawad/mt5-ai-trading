import { describe, expect, it } from 'vitest';
import { normalizeConfidencePct } from '../services/trading-ai/confidence';

describe('normalizeConfidencePct', () => {
  it('scales a raw 0-1 fraction up to a 0-100 percent', () => {
    expect(normalizeConfidencePct(0)).toBe(0);
    expect(normalizeConfidencePct(0.01)).toBe(1);
    expect(normalizeConfidencePct(0.48)).toBe(48);
    expect(normalizeConfidencePct(0.74)).toBe(74);
    expect(normalizeConfidencePct(1.0)).toBe(100);
  });

  it('leaves an already-canonical 0-100 value unchanged (never turns 74 into 7400)', () => {
    expect(normalizeConfidencePct(48)).toBe(48);
    expect(normalizeConfidencePct(74)).toBe(74);
    expect(normalizeConfidencePct(100)).toBe(100);
    expect(normalizeConfidencePct(2)).toBe(2);
    expect(normalizeConfidencePct(99)).toBe(99);
  });

  it('the raw=1 / canonical=1 boundary is explicitly defined (documented limitation, not accidental)', () => {
    // A structured-output schema requiring confidence_pct to be an integer
    // makes fractional emission from a strict-mode provider structurally
    // impossible, so this boundary is only ever reached via legacy/non-
    // compliant data — resolved as 100, matching the spec's own reference
    // heuristic (value in [0,1] => treated as a fraction).
    expect(normalizeConfidencePct(1)).toBe(100);
  });

  it('rounds to the nearest whole percent', () => {
    expect(normalizeConfidencePct(0.745)).toBe(75);
    expect(normalizeConfidencePct(0.744)).toBe(74);
    expect(normalizeConfidencePct(73.5)).toBe(74);
  });

  it('clamps out-of-range values into 0..100', () => {
    expect(normalizeConfidencePct(150)).toBe(100);
    expect(normalizeConfidencePct(-10)).toBe(0);
  });

  it('never produces NaN or a non-finite result for degenerate input', () => {
    expect(normalizeConfidencePct(Number.NaN)).toBe(0);
    expect(normalizeConfidencePct(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeConfidencePct(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
