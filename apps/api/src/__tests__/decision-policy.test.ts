import { describe, expect, it } from 'vitest';
import { AiActionPolicyInput, computeAiTradeAction } from '../services/trading-ai/decision-policy';

// ---------------------------------------------------------------------------
// "ALL VALID SETUPS ARE DEMO-ACTIONABLE" — decision-policy.ts is now a purely
// MECHANICAL mapping from entry_type/decision (+ real market/data status for
// MARKET_NOW only) to one of three actions. It never reads confidence_pct,
// tradeability_pct, Trade Score, or the Risk Engine result — those are
// completely independent, non-gating signals shown alongside the action
// (see trading-ai-service.ts / tradeability.ts).
// ---------------------------------------------------------------------------

function input(overrides: Partial<AiActionPolicyInput> = {}): AiActionPolicyInput {
  return {
    decision: 'BUY',
    entryType: 'MARKET_NOW',
    marketStatus: 'OPEN',
    dataStatus: 'LIVE',
    ...overrides,
  };
}

describe('computeAiTradeAction', () => {
  it('ENTER_NOW: MARKET_NOW entry, market open+live', () => {
    const result = computeAiTradeAction(input());
    expect(result).toEqual({ action: 'ENTER_NOW', reason: 'MARKET_ENTRY_READY', orderIntent: 'MARKET' });
  });

  it('PULLBACK plan -> WAIT_FOR_ENTRY, regardless of market/data status', () => {
    const result = computeAiTradeAction(input({ entryType: 'PULLBACK', marketStatus: 'CLOSED', dataStatus: 'STALE' }));
    expect(result).toEqual({ action: 'WAIT_FOR_ENTRY', reason: 'PENDING_ENTRY_PLAN_READY', orderIntent: 'PENDING' });
  });

  it('BREAKOUT plan -> WAIT_FOR_ENTRY, regardless of market/data status', () => {
    const result = computeAiTradeAction(input({ entryType: 'BREAKOUT', marketStatus: 'UNKNOWN', dataStatus: null }));
    expect(result).toEqual({ action: 'WAIT_FOR_ENTRY', reason: 'PENDING_ENTRY_PLAN_READY', orderIntent: 'PENDING' });
  });

  it('ENTER_NOW requires the market to be genuinely OPEN for this symbol right now', () => {
    const result = computeAiTradeAction(input({ marketStatus: 'CLOSED' }));
    expect(result).toEqual({ action: 'NO_EXECUTION', reason: 'MARKET_CLOSED', orderIntent: null });
  });

  it('ENTER_NOW requires a LIVE quote right now', () => {
    const result = computeAiTradeAction(input({ dataStatus: 'STALE' }));
    expect(result).toEqual({ action: 'NO_EXECUTION', reason: 'STALE_QUOTE', orderIntent: null });
  });

  it('a WAIT decision (genuine technical impossibility only) is always NO_EXECUTION, never gated by confidence', () => {
    const result = computeAiTradeAction(input({ decision: 'WAIT', entryType: 'NO_ENTRY' }));
    expect(result).toEqual({ action: 'NO_EXECUTION', reason: 'NO_VALID_ENTRY', orderIntent: null });
  });

  it('entry_type=NO_ENTRY is NO_EXECUTION even if decision is somehow BUY/SELL (defensive)', () => {
    const result = computeAiTradeAction(input({ decision: 'BUY', entryType: 'NO_ENTRY' }));
    expect(result).toEqual({ action: 'NO_EXECUTION', reason: 'NO_VALID_ENTRY', orderIntent: null });
  });

  it('never forces a random BUY/SELL: SELL direction flows through the same policy unchanged', () => {
    const result = computeAiTradeAction(input({ decision: 'SELL', entryType: 'MARKET_NOW' }));
    expect(result.action).toBe('ENTER_NOW');
  });

  it('never reads tradeability_pct, confidence_pct, Trade Score, or Risk Engine result — the input type has none of them', () => {
    // Purely a type-level guarantee: AiActionPolicyInput only accepts
    // decision/entryType/marketStatus/dataStatus. Any accidental
    // reintroduction of a threshold field would fail to compile here.
    const result = computeAiTradeAction({ decision: 'BUY', entryType: 'MARKET_NOW', marketStatus: 'OPEN', dataStatus: 'LIVE' });
    expect(result.action).toBe('ENTER_NOW');
  });

  it('a low-tradeability (e.g. 12%) MARKET_NOW setup still resolves to ENTER_NOW — quality never gates the action', () => {
    // tradeability_pct is not even a parameter of this function; this test
    // documents the intent that low quality is expressed elsewhere.
    const result = computeAiTradeAction(input({ entryType: 'MARKET_NOW' }));
    expect(result.action).toBe('ENTER_NOW');
  });
});
