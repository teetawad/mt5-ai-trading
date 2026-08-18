// Shared JSON Schema for the AI's structured trade plan output, mirroring
// schema.ts's zod shape. Used by every TradingAIProvider implementation so
// the required/forced-structured-output contract can never drift between
// providers (spec: "Never trust arbitrary model output").
//
// Deliberately excludes trade_score/trade_rating: those are computed
// server-side, independent of the model (see trade-score.ts, kept only as a
// secondary dataset-comparison diagnostic — see tradeability.ts for the
// model's own, primary quality signal).
export const TRADE_PLAN_JSON_SCHEMA_PROPERTIES = {
  symbol: { type: 'string' },
  asset_class: { type: 'string' },
  decision: { type: 'string', enum: ['BUY', 'SELL', 'WAIT'] },
  // Integer 0-100 (a PERCENT), never a 0-1 fraction — the "_pct" suffix and
  // integer type are both deliberate, so the schema itself is unambiguous
  // about scale (see confidence.ts for why this matters).
  confidence_pct: {
    type: 'integer', minimum: 0, maximum: 100,
    description: 'How confident the AI is in its own reading of the market, as a WHOLE PERCENT from 0 to 100 (e.g. 74 means 74%, never 0.74). This is NOT a measure of trade quality/attractiveness — see tradeability_pct.',
  },
  // Independent of confidence_pct (spec: "ALL VALID SETUPS ARE
  // DEMO-ACTIONABLE"). Descriptive quality only — never withhold a
  // direction/plan merely because this would be low; report it honestly.
  tradeability_pct: {
    type: 'integer', minimum: 0, maximum: 100,
    description: 'How ATTRACTIVE this setup is for trading, as a WHOLE PERCENT from 0 to 100 — completely independent of confidence_pct (you can be very confident in your read while judging the actual opportunity as poor, or vice versa). Report this honestly even when low (e.g. 12-34 for a genuinely weak setup) — never inflate it just to justify the direction you picked, and never use a low value as a reason to avoid picking BUY/SELL or to skip building a structured plan.',
  },
  // "FIND BEST TRADES" ranking signal — independent of confidence_pct and
  // tradeability_pct. See prompt.ts for the full scoring rubric.
  profitability_score: {
    type: 'integer', minimum: 0, maximum: 100,
    description: 'A relative, risk-adjusted PROFITABILITY assessment for this setup, as a WHOLE PERCENT-LIKE integer from 0 to 100 — NOT a win probability, NOT guaranteed profit, and NOT the same as confidence_pct or tradeability_pct. Consider: directional clarity, multi-timeframe alignment, momentum quality, entry quality, distance from support/resistance, volatility, spread, risk/reward, invalidation quality, how likely price reaches take_profit before stop_loss given this analysis, current market condition, whether the setup is stretched/overbought/oversold, and pullback/breakout structure quality. Do NOT increase this score merely because take_profit is placed far away — a distant target with weak invalidation quality or poor structure is not more profitable, only more speculative.',
  },
  market_condition: { type: 'string', description: 'Short plain-language description of current market condition, e.g. "trending bullish, moderate volatility".' },
  trend: { type: 'string', enum: ['BULLISH', 'BEARISH', 'RANGE', 'UNCLEAR'] },
  entry_type: { type: 'string', enum: ['MARKET_NOW', 'PULLBACK', 'BREAKOUT', 'NO_ENTRY'] },
  current_price: {
    type: ['number', 'null'],
    description: 'The real current market price you are reasoning against right now (near bid/ask). Required (non-null) whenever decision is BUY or SELL; null only when decision is WAIT.',
  },
  entry_price: { type: ['number', 'null'] },
  entry_zone_low: { type: ['number', 'null'] },
  entry_zone_high: { type: ['number', 'null'] },
  trigger_price: { type: ['number', 'null'] },
  pending_order_type: { type: 'string', enum: ['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP', 'NONE'] },
  stop_loss: { type: ['number', 'null'] },
  take_profit: { type: ['number', 'null'] },
  risk_reward: { type: ['number', 'null'] },
  lot_size_suggestion: { type: ['number', 'null'] },
  expected_holding_minutes: { type: ['integer', 'null'], minimum: 0 },
  plan_expiry_minutes: { type: 'integer', minimum: 5, maximum: 1440 },
  invalidation_reason: { type: ['string', 'null'] },
  reason_summary: { type: 'string' },
  reason_details: { type: 'array', items: { type: 'string' } },
  risks: { type: 'array', items: { type: 'string' }, description: 'Specific reasons this setup could fail or be lower quality (e.g. extended entry, weak risk/reward, high volatility, poor spread).' },
} as const;

export const TRADE_PLAN_JSON_SCHEMA_REQUIRED = [
  'symbol', 'asset_class', 'decision', 'confidence_pct', 'tradeability_pct', 'profitability_score', 'market_condition', 'trend',
  'entry_type', 'current_price', 'entry_price', 'entry_zone_low', 'entry_zone_high', 'trigger_price', 'pending_order_type',
  'stop_loss', 'take_profit', 'risk_reward', 'lot_size_suggestion', 'expected_holding_minutes',
  'plan_expiry_minutes', 'invalidation_reason', 'reason_summary', 'reason_details', 'risks',
] as const;

export function tradePlanJsonSchemaObject(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...TRADE_PLAN_JSON_SCHEMA_REQUIRED],
    properties: TRADE_PLAN_JSON_SCHEMA_PROPERTIES,
  };
}
