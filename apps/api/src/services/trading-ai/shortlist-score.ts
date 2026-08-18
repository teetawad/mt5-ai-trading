import { MarketAnalysisPackage, TimeframeSnapshot } from './types';

// Cheap, deterministic technical shortlist score (spec section 4) — used
// ONLY to decide which MT5-data-valid symbols are worth spending an OpenAI
// call on. Deliberately NOT the final Trade Score (trade-score.ts), which
// requires an actual AI-produced TradeAIPlan and is computed only after the
// AI has analyzed a symbol. This score never sees or influences that one.
export interface ShortlistScoreBreakdown {
  trendAlignment: number; // 0-30: H1/H4 trend agreement
  momentum: number; // 0-25: RSI room-to-move + MACD histogram agreeing with trend
  volatilityQuality: number; // 0-20: spread relative to ATR + quote freshness
  structure: number; // 0-25: price proximity to a real recent support/resistance level
}

export interface ShortlistScoreResult {
  score: number; // 0-100
  breakdown: ShortlistScoreBreakdown;
}

function timeframe(pkg: MarketAnalysisPackage, name: TimeframeSnapshot['timeframe']): TimeframeSnapshot | null {
  return pkg.timeframes.find((tf) => tf.timeframe === name) ?? null;
}

export function computeShortlistScore(pkg: MarketAnalysisPackage): ShortlistScoreResult {
  const h1 = timeframe(pkg, 'H1');
  const h4 = timeframe(pkg, 'H4');

  let trendAlignment = 0;
  if (h1 && h4) {
    const directional = (t: TimeframeSnapshot['trend']) => t === 'BULLISH' || t === 'BEARISH';
    if (h1.trend === h4.trend && directional(h1.trend)) trendAlignment = 30;
    else if (directional(h1.trend) || directional(h4.trend)) trendAlignment = 15;
  }

  let momentum = 0;
  if (h1?.rsi14 !== null && h1?.rsi14 !== undefined) {
    const rsi14 = h1.rsi14;
    if (h1.trend === 'BULLISH' && rsi14 >= 50 && rsi14 <= 75) momentum += 15;
    else if (h1.trend === 'BEARISH' && rsi14 <= 50 && rsi14 >= 25) momentum += 15;
    else if (rsi14 > 35 && rsi14 < 65) momentum += 8;
  }
  if (h1?.macdHistogram !== null && h1?.macdHistogram !== undefined) {
    if ((h1.trend === 'BULLISH' && h1.macdHistogram > 0) || (h1.trend === 'BEARISH' && h1.macdHistogram < 0)) momentum += 10;
  }
  momentum = Math.min(25, momentum);

  let volatilityQuality = 0;
  const atr14 = h1?.atr14 ?? null;
  const spread = pkg.quote.spread;
  if (atr14 !== null && atr14 > 0 && spread !== null && spread >= 0) {
    const ratio = spread / atr14;
    if (ratio < 0.05) volatilityQuality += 12;
    else if (ratio < 0.15) volatilityQuality += 6;
  }
  if (pkg.quote.quoteAgeSeconds !== null) {
    if (pkg.quote.quoteAgeSeconds <= 10) volatilityQuality += 8;
    else if (pkg.quote.quoteAgeSeconds <= 30) volatilityQuality += 4;
  }
  volatilityQuality = Math.min(20, volatilityQuality);

  let structure = 0;
  const close = h1?.close ?? null;
  const levels = h1?.supportResistance ?? [];
  if (close !== null && close > 0 && levels.length && atr14 !== null && atr14 > 0) {
    const nearestDistance = Math.min(...levels.map((level) => Math.abs(level - close)));
    const distanceInAtr = nearestDistance / atr14;
    if (distanceInAtr < 3) structure = 25;
    else if (distanceInAtr < 6) structure = 12;
  }

  return {
    score: trendAlignment + momentum + volatilityQuality + structure,
    breakdown: { trendAlignment, momentum, volatilityQuality, structure },
  };
}
