import { MarketAnalysisPackage, TradeAIPlan, TradeAITrend } from './types';

// ---------------------------------------------------------------------------
// Trade Score: an independent, deterministic, auditable "is this worth
// trading?" quality score — DELIBERATELY separate from the AI's own
// confidence_pct. AI confidence measures how sure the AI is about its own
// read of the market; Trade Score measures how attractive the resulting
// setup actually is by objective criteria computed here, server-side, from
// the same MarketAnalysisPackage the AI saw. The AI can be highly confident
// about a genuinely poor setup (e.g. a good direction call at a bad price),
// and this module is what is allowed to say so.
//
// Never treated as authoritative for execution: the Risk Engine remains the
// only gate on whether a trade may actually be submitted (spec: "Trade
// Score must NEVER override Risk Engine").
// ---------------------------------------------------------------------------

export interface TradeScoreBreakdown {
  trend: number;
  momentum: number;
  entryQuality: number;
  riskReward: number;
  marketConditions: number;
}

export type TradeRating = 'AVOID' | 'WEAK' | 'FAIR' | 'GOOD' | 'STRONG';

export const TRADE_RATING_LABEL_TH: Record<TradeRating, string> = {
  AVOID: 'ไม่น่าเทรด',
  WEAK: 'เสี่ยง / รอดีกว่า',
  FAIR: 'พอเทรดได้',
  GOOD: 'น่าเทรด',
  STRONG: 'โอกาสเด่นมาก',
};

export interface TradeScoreResult {
  tradeScore: number;
  tradeRating: TradeRating;
  tradeRatingLabelTh: string;
  breakdown: TradeScoreBreakdown;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function tradeRatingFor(score: number): TradeRating {
  if (score >= 90) return 'STRONG';
  if (score >= 75) return 'GOOD';
  if (score >= 60) return 'FAIR';
  if (score >= 40) return 'WEAK';
  return 'AVOID';
}

function trendScore(pkg: MarketAnalysisPackage, decision: 'BUY' | 'SELL'): number {
  // Multi-timeframe agreement: how many of H1/H4 (the strategic timeframes)
  // agree with the AI's chosen direction, plus a partial credit for M15.
  const relevant = pkg.timeframes.filter((tf) => tf.timeframe === 'M15' || tf.timeframe === 'H1' || tf.timeframe === 'H4');
  const weights: Record<string, number> = { M15: 4, H1: 8, H4: 8 };
  let score = 0;
  for (const tf of relevant) {
    const weight = weights[tf.timeframe] ?? 0;
    const wants: TradeAITrend = decision === 'BUY' ? 'BULLISH' : 'BEARISH';
    if (tf.trend === wants) score += weight;
    else if (tf.trend === 'RANGE' || tf.trend === 'UNCLEAR') score += weight * 0.35;
    // opposing trend earns 0 for that timeframe.
  }
  return clamp(score, 0, 20);
}

function momentumScore(pkg: MarketAnalysisPackage, decision: 'BUY' | 'SELL'): number {
  const h1 = pkg.timeframes.find((tf) => tf.timeframe === 'H1');
  if (!h1) return 8; // neutral-ish when we cannot evaluate momentum.
  let score = 10;
  if (h1.rsi14 !== null) {
    if (decision === 'BUY') score += clamp((h1.rsi14 - 50) / 2.5, -10, 10);
    else score += clamp((50 - h1.rsi14) / 2.5, -10, 10);
  }
  if (h1.macdHistogram !== null) {
    const aligned = decision === 'BUY' ? h1.macdHistogram > 0 : h1.macdHistogram < 0;
    score += aligned ? 5 : -5;
  }
  return clamp(score, 0, 20);
}

function entryQualityScore(pkg: MarketAnalysisPackage, plan: TradeAIPlan): number {
  const h1 = pkg.timeframes.find((tf) => tf.timeframe === 'H1');
  const atr = h1?.atr14 ?? null;
  const current = plan.decision === 'BUY' ? pkg.quote.ask ?? pkg.quote.bid : pkg.quote.bid ?? pkg.quote.ask;
  let score = 12;

  // A planned entry far from current price (in ATR terms) for a MARKET_NOW
  // trade is a worse (more "chased") entry than one near price, or a
  // deliberate PULLBACK/BREAKOUT plan that already accounts for that.
  const anchor = plan.entry_price ?? plan.entry_zone_high ?? plan.entry_zone_low ?? plan.trigger_price;
  if (atr && atr > 0 && current !== null && anchor !== null) {
    const distanceAtr = Math.abs(current - anchor) / atr;
    if (plan.entry_type === 'MARKET_NOW') {
      score += distanceAtr < 0.15 ? 6 : distanceAtr < 0.4 ? 2 : -4;
    } else {
      // Pullback/breakout: a reasonable planned distance from current price
      // is expected and good; only penalize extremes (implausibly far).
      score += distanceAtr < 2.5 ? 6 : distanceAtr < 5 ? 2 : -4;
    }
  }

  // Proximity to a support/resistance candidate on H1 is a quality signal
  // for the planned entry (a common technical-analysis heuristic: entries
  // that respect structure tend to be cleaner than ones that don't).
  if (h1 && anchor !== null && h1.supportResistance.length) {
    const nearestDistance = Math.min(...h1.supportResistance.map((level) => Math.abs(level - anchor)));
    const proximityAtr = atr && atr > 0 ? nearestDistance / atr : Infinity;
    if (proximityAtr < 0.5) score += 2;
  }

  return clamp(score, 0, 20);
}

function riskRewardScore(plan: TradeAIPlan): number {
  const rr = plan.risk_reward;
  if (rr === null || !Number.isFinite(rr)) return 0;
  if (rr >= 3) return 20;
  if (rr >= 2) return 16;
  if (rr >= 1.5) return 11;
  if (rr >= 1) return 5;
  return 0;
}

function marketConditionsScore(pkg: MarketAnalysisPackage): number {
  let score = 20;
  const spread = pkg.quote.spread;
  const point = pkg.quote.point;
  if (spread !== null && point && point > 0) {
    const spreadPoints = spread / point;
    if (spreadPoints > 50) score -= 8;
    else if (spreadPoints > 25) score -= 3;
  }
  const age = pkg.quote.quoteAgeSeconds;
  if (age !== null) {
    if (age > 30) score -= 8;
    else if (age > 10) score -= 3;
  }
  // Volatility suitability: an ATR that is a very large fraction of price
  // (erratic/illiquid conditions) is treated as a lower-quality environment,
  // not automatically disqualifying but worth reflecting in the score.
  const h1 = pkg.timeframes.find((tf) => tf.timeframe === 'H1');
  if (h1?.atr14 && h1.close) {
    const atrPct = h1.atr14 / h1.close;
    if (atrPct > 0.03) score -= 5;
  }
  return clamp(score, 0, 20);
}

export function computeTradeScore(pkg: MarketAnalysisPackage, plan: TradeAIPlan): TradeScoreResult | null {
  if (plan.decision === 'WAIT') return null;
  const decision = plan.decision;
  const breakdown: TradeScoreBreakdown = {
    trend: Math.round(trendScore(pkg, decision)),
    momentum: Math.round(momentumScore(pkg, decision)),
    entryQuality: Math.round(entryQualityScore(pkg, plan)),
    riskReward: Math.round(riskRewardScore(plan)),
    marketConditions: Math.round(marketConditionsScore(pkg)),
  };
  const tradeScore = clamp(
    breakdown.trend + breakdown.momentum + breakdown.entryQuality + breakdown.riskReward + breakdown.marketConditions,
    0,
    100,
  );
  const tradeRating = tradeRatingFor(tradeScore);
  return { tradeScore, tradeRating, tradeRatingLabelTh: TRADE_RATING_LABEL_TH[tradeRating], breakdown };
}
