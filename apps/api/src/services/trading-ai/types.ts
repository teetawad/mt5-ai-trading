// V3 Trading-Specialist AI contract. This module intentionally has zero
// dependency on any specific AI vendor SDK — see provider.ts for the
// swappable abstraction.

export interface TimeframeSnapshot {
  timeframe: 'M5' | 'M15' | 'H1' | 'H4';
  barCount: number;
  lastClosedTime: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  tickVolume: number | null;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  recentHigh: number | null;
  recentLow: number | null;
  supportResistance: number[];
  trend: 'BULLISH' | 'BEARISH' | 'RANGE' | 'UNCLEAR';
}

export interface MarketAnalysisPackage {
  symbol: string;
  assetClass: string;
  generatedAt: string;
  quote: {
    bid: number | null;
    ask: number | null;
    spread: number | null;
    digits: number | null;
    point: number | null;
    quoteAgeSeconds: number | null;
  };
  market: {
    status: string;
    dataStatus: string;
    sessionOpen: string | null;
    sessionClose: string | null;
    nextOpen: string | null;
  };
  timeframes: TimeframeSnapshot[];
  account: {
    balance: number | null;
    equity: number | null;
    freeMargin: number | null;
    currency: string | null;
  };
  existingPosition: {
    exists: boolean;
    side?: string | null;
    volume?: number | null;
    profit?: number | null;
  };
  existingPendingOrder: {
    exists: boolean;
    type?: string | null;
    price?: number | null;
  };
}

export interface ChartRef {
  timeframe: string;
  mediaType: string;
  imageBase64: string;
}

export type TradeAIDecision = 'BUY' | 'SELL' | 'WAIT';
export type TradeAIEntryType = 'MARKET_NOW' | 'PULLBACK' | 'BREAKOUT' | 'NO_ENTRY';
export type TradeAIPendingOrderType = 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_STOP' | 'SELL_STOP' | 'NONE';
export type TradeAITrend = 'BULLISH' | 'BEARISH' | 'RANGE' | 'UNCLEAR';

export interface TradeAIPlan {
  symbol: string;
  asset_class: string;
  decision: TradeAIDecision;
  // AI Confidence: how sure the AI is about its own read of the market.
  // Deliberately NOT the same thing as trade quality/attractiveness — see
  // tradeability_pct below (and trade-score.ts, an independent server-side
  // measurement of the same "how attractive" question, kept only for
  // dataset comparison — see trade-score.ts's own doc comment).
  //
  // Canonical representation: an INTEGER 0-100 (percent), never a 0-1
  // fraction — see confidence.ts. The field is deliberately named
  // confidence_pct (not "confidence") so the AI's own JSON schema is
  // unambiguous about the expected scale.
  confidence_pct: number;
  // Tradeability: the AI's own honest rating of how ATTRACTIVE this setup
  // is for trading — 0-100, an integer percent, same canonical
  // representation/normalization as confidence_pct (see confidence.ts's
  // normalizeTradeabilityPct). Deliberately independent of confidence_pct:
  // the AI can be highly confident in its read of the market while judging
  // the actual opportunity as poor (e.g. confidence 85, tradeability 32),
  // and vice versa. This is a DESCRIPTIVE quality label only — never a
  // probability of profit, never a win-rate estimate, and never an
  // execution gate: a low tradeability_pct must never by itself turn a
  // valid BUY/SELL plan into WATCH/NO_EXECUTION (see decision-policy.ts,
  // which no longer reads this field at all for gating purposes). Must
  // never be inflated just to "justify" whichever direction was picked —
  // a genuinely weak setup should honestly report a low value (e.g. 12-34).
  tradeability_pct: number;
  // AI Profitability Score ("FIND BEST TRADES" ranking signal, spec sections
  // 6-10): 0-100 integer, the AI's own relative assessment of how strong
  // this setup's RISK-ADJUSTED profit opportunity looks compared to other
  // scanned setups. Independent of confidence_pct (certainty about the read)
  // and tradeability_pct (how usable/attractive the setup is right now) —
  // all three may legitimately differ (e.g. confidence 85, tradeability 58,
  // profitability 63). NEVER a calibrated win probability or guaranteed
  // profit, and must NOT be inflated merely because take_profit is far away
  // (a distant TP with poor invalidation quality is NOT more profitable).
  // This is the field runOpportunityScan's TOP 10 is ranked by (primary
  // sort), with tradeability_pct/confidence_pct/risk_reward as tie-breakers
  // only — see opportunity-scan.ts's rankByProfitability.
  profitability_score: number;
  market_condition: string;
  trend: TradeAITrend;
  entry_type: TradeAIEntryType;
  // The real current market price the AI is reasoning against (near
  // bid/ask at analysis time). Required whenever decision is BUY/SELL —
  // without it, PULLBACK/BREAKOUT entries can never be checked for
  // directional sanity (e.g. a "BUY_LIMIT" whose entry is actually above
  // the current price, which is not a pullback at all). Null only for WAIT.
  current_price: number | null;
  entry_price: number | null;
  entry_zone_low: number | null;
  entry_zone_high: number | null;
  trigger_price: number | null;
  pending_order_type: TradeAIPendingOrderType;
  stop_loss: number | null;
  take_profit: number | null;
  risk_reward: number | null;
  lot_size_suggestion: number | null;
  expected_holding_minutes: number | null;
  plan_expiry_minutes: number;
  invalidation_reason: string | null;
  reason_summary: string;
  reason_details: string[];
  risks: string[];
}

export class AiProviderNotConfiguredError extends Error {
  code = 'AI_PROVIDER_NOT_CONFIGURED' as const;

  constructor(message = 'AI PROVIDER NOT CONFIGURED') {
    super(message);
    this.name = 'AiProviderNotConfiguredError';
  }
}

export class AiPlanValidationError extends Error {
  code = 'AI_PLAN_VALIDATION_FAILED' as const;
  issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'AiPlanValidationError';
    this.issues = issues;
  }
}

// Raised when a provider's raw response cannot even be turned into a
// candidate plan object (missing/empty structured output, unparsable JSON,
// etc.) — distinct from AiPlanValidationError, which is a well-formed object
// that failed strict schema rules. Never trust arbitrary model output: both
// cases must block plan creation the same way.
export class AiResponseInvalidError extends Error {
  code = 'AI_RESPONSE_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AiResponseInvalidError';
  }
}

// Raised BEFORE any MT5 call whenever a symbol isn't a real, catalog-known
// MT5 instrument — a pseudo-symbol like "SCAN"/"ALL"/"BEST"/"*" (a scanner
// sentinel value leaking into a single-symbol analysis call), a typo, or any
// other string never confirmed to exist on the connected MT5 DEMO account.
// This is the fix for the "MT5 does not recognize symbol SCAN" root cause:
// previously an unknown symbol silently defaulted to asset_class='OTHER' and
// fell through to a real MT5 symbol_info/candle call, which then failed deep
// in the stack with a confusing broker-level error instead of a clear,
// immediate, application-level rejection.
export class AiUnknownSymbolError extends Error {
  code = 'SYMBOL_NOT_IN_CATALOG' as const;

  constructor(symbol: string) {
    super(`"${symbol}" is not a real MT5 instrument in this app's synced catalog — refusing to query MT5 for a symbol that was never confirmed to exist.`);
    this.name = 'AiUnknownSymbolError';
  }
}

export class AiProviderAuthError extends Error {
  code = 'AI_PROVIDER_AUTH_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AiProviderAuthError';
  }
}

export class AiProviderBillingError extends Error {
  code = 'AI_PROVIDER_BILLING_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AiProviderBillingError';
  }
}

export class AiRequestTimeoutError extends Error {
  code = 'AI_REQUEST_TIMEOUT' as const;

  constructor(message = 'AI REQUEST TIMEOUT') {
    super(message);
    this.name = 'AiRequestTimeoutError';
  }
}

// A genuinely transient "too many requests right now" 429 — distinct from
// AiProviderBillingError (real quota/billing exhaustion, where retrying
// never helps). Raised only after the provider's own retry-with-backoff
// attempts (see provider-http.ts) are exhausted, so a burst scan across many
// symbols (e.g. "FIND BEST TRADES" over 20 shortlisted symbols) hitting a
// modest per-minute rate limit is not silently misreported as a billing
// problem — see the regression this fixes: every one of 20 shortlisted
// symbols failing with "OPENAI API BILLING/QUOTA ERROR" turned out to be
// rate limiting, not exhausted quota.
export class AiProviderRateLimitError extends Error {
  code = 'AI_PROVIDER_RATE_LIMIT_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AiProviderRateLimitError';
  }
}

export interface TradingAIProvider {
  readonly providerName: string;
  readonly model: string;
  analyze(input: { pkg: MarketAnalysisPackage; charts: ChartRef[]; promptVersion: string }): Promise<{
    raw: unknown;
    plan: TradeAIPlan;
    // The exact, unmodified confidence_pct value as it appeared in the
    // provider's parsed JSON response, BEFORE normalizeConfidencePct() ran
    // — kept only for the dev-mode "Raw AI confidence / Normalized
    // confidence" Advanced Details diagnostic (spec section "DEBUG
    // DIAGNOSTICS"). Never used for anything else; plan.confidence_pct is
    // always the one true canonical value.
    rawConfidence: unknown;
  }>;
}
