import { TradeAIEntryType } from './types';

// ---------------------------------------------------------------------------
// Decision Policy: "ALL VALID SETUPS ARE DEMO-ACTIONABLE". This module is now
// a purely MECHANICAL mapping from the AI's own entry_type/decision (plus
// the real per-symbol market/data status, for ENTER_NOW only) to one of
// three actions. It NEVER reads confidence_pct, tradeability_pct, Trade
// Score, or the Risk Engine result — quality is a descriptive concept
// (tradeability.ts) shown alongside the action, never a gate on it, and Risk
// Engine PASS/BLOCKED is its own independent, still-authoritative field
// (evaluateMt5Risk) that the UI shows separately (spec section 8/12).
//
// NO_EXECUTION replaces the old WATCH/NO_TRADE pair and means ONLY "a valid
// order could not currently be constructed" (spec section 7) — e.g. the AI
// itself reported no plan (decision=WAIT/entry_type=NO_ENTRY, reserved for
// genuine technical impossibility per prompt.ts). It never means "AI was
// cautious" or "quality was low" — those are expressed via tradeability_pct
// and never withhold an action.
// ---------------------------------------------------------------------------

export type AiTradeAction = 'ENTER_NOW' | 'WAIT_FOR_ENTRY' | 'NO_EXECUTION';

export type AiTradeActionReason =
  | 'NO_VALID_ENTRY' // decision=WAIT or entry_type=NO_ENTRY — technical impossibility only
  | 'MARKET_ENTRY_READY' // ENTER_NOW granted
  | 'PENDING_ENTRY_PLAN_READY' // WAIT_FOR_ENTRY granted
  | 'MARKET_CLOSED' // MARKET_NOW requested but the symbol's session is not OPEN right now
  | 'STALE_QUOTE' // MARKET_NOW requested but the live per-symbol data status is not LIVE
  | 'CONTRADICTORY_PLAN'; // defensive fallback; schema.ts should never let this combination through

export interface AiActionResult {
  action: AiTradeAction;
  reason: AiTradeActionReason;
  orderIntent: 'MARKET' | 'PENDING' | null;
}

export interface AiActionPolicyInput {
  decision: 'BUY' | 'SELL' | 'WAIT';
  entryType: TradeAIEntryType;
  // Real per-symbol session/data status (getMt5MarketStatus) — required only
  // to confirm a MARKET_NOW entry is genuinely enterable right now. A
  // PULLBACK/BREAKOUT pending-order plan does not need the market open at
  // analysis time (that is exactly what a pending order is for); the actual
  // placement is still independently re-checked at approval time.
  marketStatus: 'OPEN' | 'CLOSED' | 'QUOTE_ONLY' | 'TRADE_DISABLED' | 'UNKNOWN' | null;
  dataStatus: 'LIVE' | 'STALE' | 'DISCONNECTED' | null;
}

export function computeAiTradeAction(input: AiActionPolicyInput): AiActionResult {
  const { decision, entryType, marketStatus, dataStatus } = input;

  // Technical impossibility only (spec section 7/17) — the AI itself
  // reported it could not construct any plan. Never reached merely because
  // quality/confidence was low; see tradeability.ts for how that is
  // expressed instead.
  if (decision === 'WAIT' || entryType === 'NO_ENTRY') {
    return { action: 'NO_EXECUTION', reason: 'NO_VALID_ENTRY', orderIntent: null };
  }

  if (entryType === 'PULLBACK' || entryType === 'BREAKOUT') {
    // schema.ts's superRefine already guarantees a structurally complete
    // pending-order plan (entry zone/trigger, correctly-mapped
    // pending_order_type, valid stop_loss/take_profit, and current_price-
    // consistent geometry) whenever decision is BUY/SELL with entry_type
    // PULLBACK/BREAKOUT — nothing left to validate here. Risk Engine result
    // is shown as its own independent field, never folded into this action.
    return { action: 'WAIT_FOR_ENTRY', reason: 'PENDING_ENTRY_PLAN_READY', orderIntent: 'PENDING' };
  }

  if (entryType === 'MARKET_NOW') {
    if (marketStatus !== 'OPEN') {
      return { action: 'NO_EXECUTION', reason: 'MARKET_CLOSED', orderIntent: null };
    }
    if (dataStatus !== 'LIVE') {
      return { action: 'NO_EXECUTION', reason: 'STALE_QUOTE', orderIntent: null };
    }
    return { action: 'ENTER_NOW', reason: 'MARKET_ENTRY_READY', orderIntent: 'MARKET' };
  }

  // entry_type=NO_ENTRY with decision=BUY/SELL is schema-invalid and should
  // never reach here — defensive fallback only.
  return { action: 'NO_EXECUTION', reason: 'CONTRADICTORY_PLAN', orderIntent: null };
}
