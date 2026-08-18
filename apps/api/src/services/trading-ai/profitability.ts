// AI Profitability Score ("FIND BEST TRADES" ranking signal, spec sections
// 6-10): the AI's own relative, risk-adjusted profitability assessment for a
// setup — 0-100, independent of confidence_pct and tradeability_pct (see
// types.ts). UI label: "AI PROFITABILITY" / "โอกาสทำกำไรตามการประเมินของ AI".
// NEVER a calibrated win probability or guaranteed-profit claim — display
// only as "AI Profitability: NN/100", never "NN% chance of winning".

export interface ProfitabilityResult {
  profitabilityScore: number;
}

export function deriveProfitability(profitabilityScoreRaw: number): ProfitabilityResult {
  const profitabilityScore = Math.max(0, Math.min(100, Math.round(profitabilityScoreRaw)));
  return { profitabilityScore };
}
