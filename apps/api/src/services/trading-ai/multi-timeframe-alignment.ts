import { MarketAnalysisPackage, TimeframeSnapshot } from './types';

// Multi-timeframe alignment score (owner spec section 4): M5 stays the
// execution timeframe (entry timing); M15 is setup structure; H1 is the
// primary trend; H4 is macro context. A setup where every timeframe agrees
// with the AI's own decision direction scores highest; a setup where the
// higher timeframes actively disagree scores meaningfully lower — but this
// is only ever a QUALITY PENALTY feeding into final_quality_score, never an
// automatic rejection of counter-trend setups (spec: "Do not automatically
// reject every counter-trend setup").

export interface MultiTimeframeAlignmentBreakdown {
  h4: number;
  h1: number;
  m15: number;
  m5: number;
}

export interface MultiTimeframeAlignmentResult {
  score: number; // 0-100
  breakdown: MultiTimeframeAlignmentBreakdown;
}

// Weighted so the primary trend (H1) and macro context (H4) matter most —
// M15/M5 already had to structurally support the AI's entry_type/pending
// order for a plan to exist at all, so they contribute less as a
// differentiator here. Sums to 100.
const WEIGHTS = { h4: 25, h1: 30, m15: 25, m5: 20 } as const;

function timeframe(pkg: MarketAnalysisPackage, name: TimeframeSnapshot['timeframe']): TimeframeSnapshot | null {
  return pkg.timeframes.find((tf) => tf.timeframe === name) ?? null;
}

// 1 = timeframe trend agrees with the decision direction, 0 = actively
// opposes it, 0.5 = neutral (RANGE/UNCLEAR, or the timeframe is missing) —
// never a hard reject, always a partial-credit quality signal.
function agreement(trend: TimeframeSnapshot['trend'] | undefined, direction: 'BUY' | 'SELL'): number {
  if (trend === undefined) return 0.5;
  if (trend === 'BULLISH') return direction === 'BUY' ? 1 : 0;
  if (trend === 'BEARISH') return direction === 'SELL' ? 1 : 0;
  return 0.5; // RANGE or UNCLEAR
}

export function computeMultiTimeframeAlignmentScore(pkg: MarketAnalysisPackage, direction: 'BUY' | 'SELL'): MultiTimeframeAlignmentResult {
  const h4 = timeframe(pkg, 'H4');
  const h1 = timeframe(pkg, 'H1');
  const m15 = timeframe(pkg, 'M15');
  const m5 = timeframe(pkg, 'M5');

  const rawH4 = WEIGHTS.h4 * agreement(h4?.trend, direction);
  const rawH1 = WEIGHTS.h1 * agreement(h1?.trend, direction);
  const rawM15 = WEIGHTS.m15 * agreement(m15?.trend, direction);
  const rawM5 = WEIGHTS.m5 * agreement(m5?.trend, direction);

  // Round the total once from the raw (unrounded) components — rounding each
  // component first and then summing can drift the total off by a point or
  // two (e.g. four all-neutral 0.5-agreement components would round to 51,
  // not 50). breakdown is still individually rounded for display.
  const score = Math.max(0, Math.min(100, Math.round(rawH4 + rawH1 + rawM15 + rawM5)));
  const breakdown: MultiTimeframeAlignmentBreakdown = {
    h4: Math.round(rawH4),
    h1: Math.round(rawH1),
    m15: Math.round(rawM15),
    m5: Math.round(rawM5),
  };
  return { score, breakdown };
}
