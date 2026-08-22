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

// M5 Fast Learning shortlist score (spec section 2): re-weights the same
// cheap, deterministic pre-filter so M5 (this mode's execution timeframe —
// entry timing/momentum confirmation) and M15 (setup/pullback/breakout
// structure) dominate, while H1 (primary trend) and H4 (major context) act
// as smaller directional-alignment factors rather than the primary signal.
// Never removes H1/H4 from consideration (spec: "Do NOT remove higher
// timeframes") — only computeShortlistScore's H1/H4-centric weighting is
// left untouched for the existing manual "FIND BEST TRADES" scanner.
export interface M5ShortlistScoreBreakdown {
  higherTimeframeContext: number; // 0-15: H4 context + H1 trend agreement
  m5EntryTiming: number; // 0-40: M5 RSI/MACD momentum + spread-vs-M5-ATR quality
  m15Structure: number; // 0-30: M15 proximity to a real recent support/resistance level
  m5m15Alignment: number; // 0-15: M5 trend agrees with M15 trend (entry timing confirms the setup)
}

export interface M5ShortlistScoreResult {
  score: number; // 0-100
  breakdown: M5ShortlistScoreBreakdown;
}

function directionalTrend(t: TimeframeSnapshot['trend']): boolean {
  return t === 'BULLISH' || t === 'BEARISH';
}

export function computeM5ShortlistScore(pkg: MarketAnalysisPackage): M5ShortlistScoreResult {
  const m5 = timeframe(pkg, 'M5');
  const m15 = timeframe(pkg, 'M15');
  const h1 = timeframe(pkg, 'H1');
  const h4 = timeframe(pkg, 'H4');

  let higherTimeframeContext = 0;
  if (h1 && h4) {
    if (h1.trend === h4.trend && directionalTrend(h1.trend)) higherTimeframeContext = 15;
    else if (directionalTrend(h1.trend) || directionalTrend(h4.trend)) higherTimeframeContext = 7;
  }

  let m5EntryTiming = 0;
  if (m5?.rsi14 !== null && m5?.rsi14 !== undefined) {
    const rsi14 = m5.rsi14;
    if (m5.trend === 'BULLISH' && rsi14 >= 50 && rsi14 <= 75) m5EntryTiming += 15;
    else if (m5.trend === 'BEARISH' && rsi14 <= 50 && rsi14 >= 25) m5EntryTiming += 15;
    else if (rsi14 > 35 && rsi14 < 65) m5EntryTiming += 8;
  }
  if (m5?.macdHistogram !== null && m5?.macdHistogram !== undefined) {
    if ((m5.trend === 'BULLISH' && m5.macdHistogram > 0) || (m5.trend === 'BEARISH' && m5.macdHistogram < 0)) m5EntryTiming += 10;
  }
  const m5Atr = m5?.atr14 ?? null;
  const spread = pkg.quote.spread;
  if (m5Atr !== null && m5Atr > 0 && spread !== null && spread >= 0) {
    // A tighter spread-vs-M5-ATR bar than the H1-scale version: M5 candles
    // are themselves much smaller, so the same absolute spread eats a much
    // bigger share of a typical M5 move (spec section 5: never let SL/TP sit
    // inside spread/noise, which starts with never shortlisting a symbol
    // whose spread already dominates its M5 volatility).
    const ratio = spread / m5Atr;
    if (ratio < 0.08) m5EntryTiming += 15;
    else if (ratio < 0.2) m5EntryTiming += 7;
  }
  m5EntryTiming = Math.min(40, m5EntryTiming);

  let m15Structure = 0;
  const m15Close = m15?.close ?? null;
  const m15Levels = m15?.supportResistance ?? [];
  const m15Atr = m15?.atr14 ?? null;
  if (m15Close !== null && m15Close > 0 && m15Levels.length && m15Atr !== null && m15Atr > 0) {
    const nearestDistance = Math.min(...m15Levels.map((level) => Math.abs(level - m15Close)));
    const distanceInAtr = nearestDistance / m15Atr;
    if (distanceInAtr < 3) m15Structure = 30;
    else if (distanceInAtr < 6) m15Structure = 15;
  }

  let m5m15Alignment = 0;
  if (m5 && m15) {
    if (m5.trend === m15.trend && directionalTrend(m5.trend)) m5m15Alignment = 15;
    else if (directionalTrend(m5.trend) && directionalTrend(m15.trend)) m5m15Alignment = 5; // opposite directions: entry timeframe fighting the setup
  }

  return {
    score: higherTimeframeContext + m5EntryTiming + m15Structure + m5m15Alignment,
    breakdown: { higherTimeframeContext, m5EntryTiming, m15Structure, m5m15Alignment },
  };
}
