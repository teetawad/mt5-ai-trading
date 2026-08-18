// Tradeability: the AI's own honest 0-100 rating of "how attractive is this
// setup for trading" (spec: "ALL VALID SETUPS ARE DEMO-ACTIONABLE"). This is
// a DESCRIPTIVE quality label derived straight from the AI's own
// tradeability_pct (types.ts) — never a probability of profit, never a
// calibrated win-rate estimate unless/until real DEMO outcome data proves
// it (see action-stats.ts), and never an execution gate: decision-policy.ts
// does not read this value at all when deciding ENTER_NOW/WAIT_FOR_ENTRY/
// NO_EXECUTION. A low-quality setup can still be DEMO-actionable; only a
// technically invalid one cannot.

export type TradeabilityRating = 'STRONG' | 'GOOD' | 'FAIR' | 'LOW' | 'VERY_LOW';

export const TRADEABILITY_RATING_LABEL_TH: Record<TradeabilityRating, string> = {
  STRONG: 'น่าเทรดมาก',
  GOOD: 'น่าเทรด',
  FAIR: 'ปานกลาง',
  LOW: 'ความน่าสนใจต่ำ',
  VERY_LOW: 'คุณภาพต่ำ / เสี่ยงสูง',
};

export interface TradeabilityResult {
  tradeabilityPct: number;
  rating: TradeabilityRating;
  ratingLabelTh: string;
}

export function tradeabilityRatingFor(pct: number): TradeabilityRating {
  if (pct >= 85) return 'STRONG';
  if (pct >= 70) return 'GOOD';
  if (pct >= 50) return 'FAIR';
  if (pct >= 30) return 'LOW';
  return 'VERY_LOW';
}

export function deriveTradeability(tradeabilityPctRaw: number): TradeabilityResult {
  const tradeabilityPct = Math.max(0, Math.min(100, Math.round(tradeabilityPctRaw)));
  const rating = tradeabilityRatingFor(tradeabilityPct);
  return { tradeabilityPct, rating, ratingLabelTh: TRADEABILITY_RATING_LABEL_TH[rating] };
}
