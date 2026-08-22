import { z } from 'zod';
import { normalizeConfidencePct, normalizeProfitabilityScore, normalizeTradeabilityPct } from './confidence';
import { AiPlanValidationError, TradeAIPlan } from './types';

const nullableFiniteNumber = z.number().finite().nullable();

// Strict schema for the AI's structured trade plan (spec section 6). The AI
// produces a PLAN ONLY — it is validated here before ever touching the Risk
// Engine or MT5, and it is never allowed to call order_send() itself.
export const tradeAIPlanSchema = z
  .object({
    symbol: z.string().min(1),
    asset_class: z.string().min(1),
    decision: z.enum(['BUY', 'SELL', 'WAIT']),
    // The JSON schema forces the provider to emit an integer 0-100, but
    // models have empirically still returned a 0-1 fraction despite that
    // instruction (the exact root cause of the "AI Confidence: 1%" bug —
    // Math.round(0.74) === 1). normalizeConfidencePct is the single,
    // tested normalization point: a genuinely-canonical value (2-100)
    // passes through unchanged, a fractional 0-1 value is scaled up.
    confidence_pct: z.number().transform(normalizeConfidencePct),
    // Independent of confidence_pct (spec: "ALL VALID SETUPS ARE
    // DEMO-ACTIONABLE" — see tradeability.ts). Same 0-100/0-1-fraction
    // normalization as confidence_pct; never validated against any
    // threshold here — quality is descriptive only, never a gate.
    tradeability_pct: z.number().transform(normalizeTradeabilityPct),
    // "FIND BEST TRADES" ranking signal (spec sections 6-10) — independent of
    // confidence_pct/tradeability_pct, same 0-100/0-1-fraction normalization.
    // Never validated against a threshold here; a low value never gates a
    // plan, it only affects TOP 10 ranking order in opportunity-scan.ts.
    profitability_score: z.number().transform(normalizeProfitabilityScore),
    market_condition: z.string().default(''),
    trend: z.enum(['BULLISH', 'BEARISH', 'RANGE', 'UNCLEAR']),
    entry_type: z.enum(['MARKET_NOW', 'PULLBACK', 'BREAKOUT', 'NO_ENTRY']),
    current_price: nullableFiniteNumber,
    entry_price: nullableFiniteNumber,
    entry_zone_low: nullableFiniteNumber,
    entry_zone_high: nullableFiniteNumber,
    trigger_price: nullableFiniteNumber,
    pending_order_type: z.enum(['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP', 'NONE']),
    stop_loss: nullableFiniteNumber,
    take_profit: nullableFiniteNumber,
    risk_reward: nullableFiniteNumber,
    lot_size_suggestion: nullableFiniteNumber,
    expected_holding_minutes: z.number().int().min(0).nullable(),
    plan_expiry_minutes: z.number().int().min(5).max(1440),
    invalidation_reason: z.string().nullable(),
    reason_summary: z.string().min(1),
    reason_details: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
  })
  .superRefine((plan, ctx) => {
    if (plan.decision === 'WAIT') return;

    // All numeric prices supplied on an actionable plan must be finite
    // positive numbers (finiteness is already enforced by
    // nullableFiniteNumber above) — never zero or negative.
    const positivePriceFields: Array<[number | null, string]> = [
      [plan.current_price, 'current_price'],
      [plan.entry_price, 'entry_price'],
      [plan.entry_zone_low, 'entry_zone_low'],
      [plan.entry_zone_high, 'entry_zone_high'],
      [plan.trigger_price, 'trigger_price'],
      [plan.stop_loss, 'stop_loss'],
      [plan.take_profit, 'take_profit'],
    ];
    for (const [value, field] of positivePriceFields) {
      if (value !== null && value <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a positive number`, path: [field] });
      }
    }

    if (plan.entry_type === 'NO_ENTRY') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry_type must not be NO_ENTRY when decision is BUY/SELL', path: ['entry_type'] });
    }
    if (plan.stop_loss === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stop_loss is required for BUY/SELL', path: ['stop_loss'] });
    if (plan.take_profit === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'take_profit is required for BUY/SELL', path: ['take_profit'] });

    // current_price is the reference point every pending-order geometry
    // check below is anchored to — without it a PULLBACK/BREAKOUT plan can
    // never be told apart from a contradictory one (spec: "AI can write
    // 'wait for pullback' ... but fail to return the corresponding
    // structured actionable entry plan").
    if (plan.current_price === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'current_price is required for BUY/SELL', path: ['current_price'] });
    }

    if (plan.entry_type === 'MARKET_NOW' && plan.entry_price === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry_price is required for MARKET_NOW', path: ['entry_price'] });
    }

    if (plan.entry_zone_low !== null && plan.entry_zone_high !== null && plan.entry_zone_low > plan.entry_zone_high) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry_zone_low must be less than or equal to entry_zone_high', path: ['entry_zone_low'] });
    }

    if (plan.entry_type === 'PULLBACK') {
      // entry_zone_low/entry_zone_high are a display/reasoning aid, not
      // execution-critical: every downstream consumer (referenceEntryForRisk
      // in trading-ai-service.ts, opportunity-scan.ts's entry price fallback
      // chain) already treats entry_price as the primary value and only
      // falls back to the zone when entry_price itself is missing. Requiring
      // BOTH regardless of entry_price contradicted that and rejected
      // otherwise-valid plans over an optional field — only require the zone
      // when entry_price wasn't given at all.
      if (plan.entry_price === null && (plan.entry_zone_low === null || plan.entry_zone_high === null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry_price, or both entry_zone_low and entry_zone_high, is required for PULLBACK', path: ['entry_price'] });
      }
      if (plan.pending_order_type !== 'BUY_LIMIT' && plan.pending_order_type !== 'SELL_LIMIT') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PULLBACK must map to BUY_LIMIT or SELL_LIMIT', path: ['pending_order_type'] });
      }
      if (plan.decision === 'BUY' && plan.pending_order_type !== 'BUY_LIMIT') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PULLBACK BUY must use BUY_LIMIT', path: ['pending_order_type'] });
      }
      if (plan.decision === 'SELL' && plan.pending_order_type !== 'SELL_LIMIT') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PULLBACK SELL must use SELL_LIMIT', path: ['pending_order_type'] });
      }
      if (plan.entry_price !== null && plan.entry_zone_low !== null && plan.entry_zone_high !== null
        && (plan.entry_price < plan.entry_zone_low || plan.entry_price > plan.entry_zone_high)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entry_price must fall within entry_zone_low/entry_zone_high for PULLBACK', path: ['entry_price'] });
      }
    }
    if (plan.entry_type === 'BREAKOUT') {
      if (plan.trigger_price === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'trigger_price is required for BREAKOUT', path: ['trigger_price'] });
      }
      if (plan.decision === 'BUY' && plan.pending_order_type !== 'BUY_STOP') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BREAKOUT BUY must use BUY_STOP', path: ['pending_order_type'] });
      }
      if (plan.decision === 'SELL' && plan.pending_order_type !== 'SELL_STOP') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BREAKOUT SELL must use SELL_STOP', path: ['pending_order_type'] });
      }
    }

    // Pending-order geometry must be logically consistent with the AI's own
    // reported current_price: a BUY_LIMIT/SELL_STOP entry that already sits
    // on the wrong side of the market is not a pullback/breakout at all, and
    // must be rejected here rather than silently collapsing into WATCH
    // downstream (spec: "INVALID_PENDING_PLAN"). Deliberately strict (no
    // tolerance): an entry exactly AT current price is not a valid
    // pullback/breakout either, and broker-precision rounding is handled
    // separately, downstream, once symbol_info (digits/point) is actually
    // available (see checkBrokerStopDistance) — this module never sees that.
    if (plan.current_price !== null && (plan.entry_type === 'PULLBACK' || plan.entry_type === 'BREAKOUT')) {
      const anchor = plan.entry_type === 'BREAKOUT'
        ? plan.trigger_price
        : plan.entry_price ?? (plan.decision === 'BUY' ? plan.entry_zone_high : plan.entry_zone_low);
      if (anchor !== null) {
        const current = plan.current_price;
        const rule: Partial<Record<typeof plan.pending_order_type, { ok: boolean; message: string }>> = {
          BUY_LIMIT: { ok: anchor < current, message: 'BUY LIMIT entry must be below current market price' },
          SELL_LIMIT: { ok: anchor > current, message: 'SELL LIMIT entry must be above current market price' },
          BUY_STOP: { ok: anchor > current, message: 'BUY STOP entry must be above current market price' },
          SELL_STOP: { ok: anchor < current, message: 'SELL STOP entry must be below current market price' },
        };
        const check = rule[plan.pending_order_type];
        if (check && !check.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.message, path: [plan.entry_type === 'BREAKOUT' ? 'trigger_price' : 'entry_price'] });
        }
      }
    }

    const sl = plan.stop_loss;
    const tp = plan.take_profit;
    const anchor = plan.entry_price ?? (plan.entry_type === 'PULLBACK' ? plan.entry_zone_low : plan.trigger_price);
    if (sl !== null && tp !== null && anchor !== null) {
      if (plan.decision === 'BUY' && !(sl < anchor && tp > anchor)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BUY requires stop_loss below and take_profit above the planned entry', path: ['stop_loss'] });
      }
      if (plan.decision === 'SELL' && !(sl > anchor && tp < anchor)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SELL requires stop_loss above and take_profit below the planned entry', path: ['stop_loss'] });
      }
    }
  });

export function parseTradeAIPlan(raw: unknown): TradeAIPlan {
  const result = tradeAIPlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new AiPlanValidationError('AI response failed strict schema validation', issues);
  }
  return result.data as TradeAIPlan;
}
