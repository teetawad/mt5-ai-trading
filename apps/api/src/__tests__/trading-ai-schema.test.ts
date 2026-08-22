import { describe, expect, it } from 'vitest';
import { parseTradeAIPlan } from '../services/trading-ai/schema';
import { AiPlanValidationError } from '../services/trading-ai/types';

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'SGDJPY',
    asset_class: 'FOREX',
    decision: 'WAIT',
    confidence_pct: 50,
    tradeability_pct: 50,
    profitability_score: 50,
    market_condition: 'ranging',
    trend: 'RANGE',
    entry_type: 'NO_ENTRY',
    current_price: null,
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    trigger_price: null,
    pending_order_type: 'NONE',
    stop_loss: null,
    take_profit: null,
    risk_reward: null,
    lot_size_suggestion: null,
    expected_holding_minutes: null,
    plan_expiry_minutes: 60,
    invalidation_reason: null,
    reason_summary: 'No clear setup right now.',
    reason_details: ['Price is ranging.'],
    risks: [],
    ...overrides,
  };
}

describe('Trading AI plan schema', () => {
  it('accepts a WAIT plan with no entry fields', () => {
    expect(() => parseTradeAIPlan(basePlan())).not.toThrow();
  });

  it('accepts a valid MARKET_NOW BUY plan', () => {
    const plan = parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'MARKET_NOW',
      current_price: 124.75,
      entry_price: 124.75,
      stop_loss: 124.6,
      take_profit: 125.05,
      risk_reward: 2,
      pending_order_type: 'NONE',
      reason_summary: 'Bullish breakout with momentum.',
    }));
    expect(plan.decision).toBe('BUY');
  });

  it('accepts a valid PULLBACK BUY plan mapped to BUY_LIMIT', () => {
    const plan = parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'PULLBACK',
      current_price: 124.9,
      entry_zone_low: 124.6,
      entry_zone_high: 124.72,
      pending_order_type: 'BUY_LIMIT',
      stop_loss: 124.5,
      take_profit: 125.0,
      risk_reward: 1.8,
    }));
    expect(plan.pending_order_type).toBe('BUY_LIMIT');
  });

  it('accepts a valid BREAKOUT SELL plan mapped to SELL_STOP', () => {
    const plan = parseTradeAIPlan(basePlan({
      decision: 'SELL',
      entry_type: 'BREAKOUT',
      current_price: 124.7,
      trigger_price: 124.5,
      pending_order_type: 'SELL_STOP',
      stop_loss: 124.65,
      take_profit: 124.1,
      risk_reward: 2.6,
    }));
    expect(plan.pending_order_type).toBe('SELL_STOP');
  });

  it('rejects PULLBACK BUY mapped to the wrong pending order type', () => {
    expect(() => parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'PULLBACK',
      entry_zone_low: 124.6,
      entry_zone_high: 124.72,
      pending_order_type: 'SELL_LIMIT',
      stop_loss: 124.5,
      take_profit: 125.0,
    }))).toThrow(AiPlanValidationError);
  });

  it('rejects BREAKOUT without a trigger_price', () => {
    expect(() => parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'BREAKOUT',
      pending_order_type: 'BUY_STOP',
      stop_loss: 124.5,
      take_profit: 125.0,
    }))).toThrow(AiPlanValidationError);
  });

  it('rejects BUY/SELL without stop_loss or take_profit', () => {
    expect(() => parseTradeAIPlan(basePlan({
      decision: 'SELL',
      entry_type: 'MARKET_NOW',
      entry_price: 124.75,
    }))).toThrow(AiPlanValidationError);
  });

  it('rejects a BUY plan whose stop_loss is above entry', () => {
    expect(() => parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'MARKET_NOW',
      entry_price: 124.75,
      stop_loss: 124.90,
      take_profit: 125.05,
    }))).toThrow(AiPlanValidationError);
  });

  it('rejects decision=BUY with entry_type=NO_ENTRY', () => {
    expect(() => parseTradeAIPlan(basePlan({
      decision: 'BUY',
      entry_type: 'NO_ENTRY',
      stop_loss: 124.6,
      take_profit: 125.05,
    }))).toThrow(AiPlanValidationError);
  });

  it('rejects a malformed non-object payload', () => {
    expect(() => parseTradeAIPlan('not a plan')).toThrow(AiPlanValidationError);
  });

  describe('current_price and pending-order geometry (spec: "INVALID_PENDING_PLAN")', () => {
    function pullbackBuy(overrides: Record<string, unknown> = {}) {
      return basePlan({
        decision: 'BUY', entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
        current_price: 100, entry_zone_low: 95, entry_zone_high: 98,
        stop_loss: 93, take_profit: 105, risk_reward: 2,
        ...overrides,
      });
    }
    function pullbackSell(overrides: Record<string, unknown> = {}) {
      return basePlan({
        decision: 'SELL', entry_type: 'PULLBACK', pending_order_type: 'SELL_LIMIT',
        current_price: 100, entry_zone_low: 102, entry_zone_high: 105,
        stop_loss: 107, take_profit: 95, risk_reward: 2,
        ...overrides,
      });
    }
    function breakoutBuy(overrides: Record<string, unknown> = {}) {
      return basePlan({
        decision: 'BUY', entry_type: 'BREAKOUT', pending_order_type: 'BUY_STOP',
        current_price: 100, trigger_price: 105,
        stop_loss: 98, take_profit: 115, risk_reward: 2,
        ...overrides,
      });
    }
    function breakoutSell(overrides: Record<string, unknown> = {}) {
      return basePlan({
        decision: 'SELL', entry_type: 'BREAKOUT', pending_order_type: 'SELL_STOP',
        current_price: 100, trigger_price: 95,
        stop_loss: 102, take_profit: 80, risk_reward: 2,
        ...overrides,
      });
    }

    it('BUY_LIMIT: entry below current is valid', () => {
      expect(() => parseTradeAIPlan(pullbackBuy())).not.toThrow();
    });
    it('BUY_LIMIT: entry at/above current is invalid', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ entry_zone_low: 100, entry_zone_high: 102 }))).toThrow(AiPlanValidationError);
    });

    it('SELL_LIMIT: entry above current is valid', () => {
      expect(() => parseTradeAIPlan(pullbackSell())).not.toThrow();
    });
    it('SELL_LIMIT: entry at/below current is invalid', () => {
      expect(() => parseTradeAIPlan(pullbackSell({ entry_zone_low: 98, entry_zone_high: 100 }))).toThrow(AiPlanValidationError);
    });

    it('BUY_STOP: trigger above current is valid', () => {
      expect(() => parseTradeAIPlan(breakoutBuy())).not.toThrow();
    });
    it('BUY_STOP: trigger at/below current is invalid', () => {
      expect(() => parseTradeAIPlan(breakoutBuy({ trigger_price: 100 }))).toThrow(AiPlanValidationError);
    });

    it('SELL_STOP: trigger below current is valid', () => {
      expect(() => parseTradeAIPlan(breakoutSell())).not.toThrow();
    });
    it('SELL_STOP: trigger at/above current is invalid', () => {
      expect(() => parseTradeAIPlan(breakoutSell({ trigger_price: 100 }))).toThrow(AiPlanValidationError);
    });

    it('rejects a BUY/SELL plan missing current_price entirely', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ current_price: null }))).toThrow(AiPlanValidationError);
    });

    it('rejects an entry zone where entry_zone_low > entry_zone_high', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ entry_zone_low: 99, entry_zone_high: 95 }))).toThrow(AiPlanValidationError);
    });

    it('rejects a PULLBACK entry_price that falls outside its own entry zone', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ entry_price: 90 }))).toThrow(AiPlanValidationError);
    });

    // Regression fix: entry_zone_low/entry_zone_high are a display/reasoning
    // aid, not execution-critical (referenceEntryForRisk and the scan's own
    // entry-price fallback chain already treat entry_price as primary and
    // only fall back to the zone) — a PULLBACK plan with a valid entry_price
    // but no zone must not be technically blocked over an optional field.
    it('accepts a PULLBACK plan with a valid entry_price and no entry zone at all (optional field)', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ entry_price: 96, entry_zone_low: null, entry_zone_high: null }))).not.toThrow();
    });
    it('accepts a PULLBACK SELL plan with a valid entry_price and no entry zone at all', () => {
      expect(() => parseTradeAIPlan(pullbackSell({ entry_price: 103, entry_zone_low: null, entry_zone_high: null }))).not.toThrow();
    });
    it('still rejects PULLBACK when BOTH entry_price and entry_zone are missing (no execution-critical price at all)', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ entry_price: null, entry_zone_low: null, entry_zone_high: null }))).toThrow(AiPlanValidationError);
    });

    it('rejects BREAKOUT missing trigger_price even when current_price is present', () => {
      expect(() => parseTradeAIPlan(breakoutBuy({ trigger_price: null }))).toThrow(AiPlanValidationError);
    });

    it('rejects a non-positive price field (e.g. a zero stop_loss)', () => {
      expect(() => parseTradeAIPlan(pullbackBuy({ stop_loss: 0 }))).toThrow(AiPlanValidationError);
    });
  });

  describe('confidence_pct normalization (end-to-end through schema parsing)', () => {
    it('a canonical integer 0-100 confidence_pct passes through unchanged', () => {
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 48 })).confidence_pct).toBe(48);
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 74 })).confidence_pct).toBe(74);
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 100 })).confidence_pct).toBe(100);
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 1 })).confidence_pct).toBe(100); // documented boundary — see confidence.ts
    });

    it('a fractional 0-1 confidence_pct (the reported bug shape) is normalized to a whole percent', () => {
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 0.74 })).confidence_pct).toBe(74);
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 0.01 })).confidence_pct).toBe(1);
      expect(parseTradeAIPlan(basePlan({ confidence_pct: 0 })).confidence_pct).toBe(0);
    });

    it('still rejects a non-numeric or missing confidence_pct outright', () => {
      const withoutConfidence: Record<string, unknown> = basePlan();
      delete withoutConfidence.confidence_pct;
      expect(() => parseTradeAIPlan(withoutConfidence)).toThrow(AiPlanValidationError);
      expect(() => parseTradeAIPlan(basePlan({ confidence_pct: 'high' }))).toThrow(AiPlanValidationError);
    });
  });

  describe('tradeability_pct normalization (end-to-end through schema parsing) — independent of confidence_pct', () => {
    it('a canonical integer 0-100 tradeability_pct passes through unchanged', () => {
      expect(parseTradeAIPlan(basePlan({ tradeability_pct: 12 })).tradeability_pct).toBe(12);
      expect(parseTradeAIPlan(basePlan({ tradeability_pct: 78 })).tradeability_pct).toBe(78);
      expect(parseTradeAIPlan(basePlan({ tradeability_pct: 100 })).tradeability_pct).toBe(100);
    });

    it('a fractional 0-1 tradeability_pct (same bug shape as confidence_pct) is normalized to a whole percent', () => {
      expect(parseTradeAIPlan(basePlan({ tradeability_pct: 0.32 })).tradeability_pct).toBe(32);
    });

    it('is never validated against any threshold — a very low value still parses successfully', () => {
      expect(() => parseTradeAIPlan(basePlan({ tradeability_pct: 5 }))).not.toThrow();
      expect(parseTradeAIPlan(basePlan({ tradeability_pct: 5 })).tradeability_pct).toBe(5);
    });

    it('still rejects a non-numeric or missing tradeability_pct outright', () => {
      const withoutTradeability: Record<string, unknown> = basePlan();
      delete withoutTradeability.tradeability_pct;
      expect(() => parseTradeAIPlan(withoutTradeability)).toThrow(AiPlanValidationError);
    });

    it('stays decoupled from confidence_pct — high confidence with low tradeability parses fine', () => {
      const plan = parseTradeAIPlan(basePlan({ confidence_pct: 85, tradeability_pct: 32 }));
      expect(plan.confidence_pct).toBe(85);
      expect(plan.tradeability_pct).toBe(32);
    });
  });

  describe('profitability_score normalization (end-to-end through schema parsing) — independent of confidence_pct/tradeability_pct', () => {
    it('a canonical integer 0-100 profitability_score passes through unchanged', () => {
      expect(parseTradeAIPlan(basePlan({ profitability_score: 0 })).profitability_score).toBe(0);
      expect(parseTradeAIPlan(basePlan({ profitability_score: 63 })).profitability_score).toBe(63);
      expect(parseTradeAIPlan(basePlan({ profitability_score: 100 })).profitability_score).toBe(100);
    });

    it('a fractional 0-1 profitability_score (same bug shape as confidence_pct/tradeability_pct) is normalized to a whole percent', () => {
      expect(parseTradeAIPlan(basePlan({ profitability_score: 0.63 })).profitability_score).toBe(63);
    });

    it('clamps an out-of-range value into 0-100 rather than throwing', () => {
      expect(parseTradeAIPlan(basePlan({ profitability_score: 140 })).profitability_score).toBeLessThanOrEqual(100);
      expect(parseTradeAIPlan(basePlan({ profitability_score: -20 })).profitability_score).toBeGreaterThanOrEqual(0);
    });

    it('is never validated against any threshold — a very low value still parses successfully', () => {
      expect(() => parseTradeAIPlan(basePlan({ profitability_score: 3 }))).not.toThrow();
      expect(parseTradeAIPlan(basePlan({ profitability_score: 3 })).profitability_score).toBe(3);
    });

    it('still rejects a non-numeric or missing profitability_score outright', () => {
      const withoutProfitability: Record<string, unknown> = basePlan();
      delete withoutProfitability.profitability_score;
      expect(() => parseTradeAIPlan(withoutProfitability)).toThrow(AiPlanValidationError);
    });

    it('stays decoupled from confidence_pct and tradeability_pct — all three may legitimately differ', () => {
      const plan = parseTradeAIPlan(basePlan({ confidence_pct: 85, tradeability_pct: 58, profitability_score: 63 }));
      expect(plan.confidence_pct).toBe(85);
      expect(plan.tradeability_pct).toBe(58);
      expect(plan.profitability_score).toBe(63);
    });
  });
});
