// Canonical AI Confidence representation (spec): an integer 0-100 (percent).
// NEVER a 0-1 fraction. This is the single normalization point used both to
// validate/normalize fresh AI responses (schema.ts) and to migrate legacy
// stored data (see database/migrations/0034_confidence_pct.sql, which
// implements the identical heuristic in SQL).
//
// Root cause this exists to fix: despite the AI being asked for a 0-100
// value, models routinely return a 0-1 probability instead (e.g. 0.74).
// That value trivially satisfies a loose "number between 0 and 100" check,
// so it was silently accepted and then displayed via Math.round(0.74) = 1,
// i.e. "1%" — reproducing the reported bug for nearly every confidence in
// (0.5, 1.5).
//
// Known, deliberate limitation: a raw value of exactly 1 is ambiguous (a
// genuine "1%" vs. a fractional "100%") and is resolved as 100 — the same
// choice spelled out in the spec's own reference pseudocode. This is safe
// in practice because the AI's structured-output schema requires
// confidence_pct to be a JSON integer, which strict-mode providers cannot
// violate — so a compliant provider only ever lands on this boundary via a
// deliberate, genuine "1", which is a vanishingly unlikely thing for a
// model to report as a whole-number confidence anyway.
export function normalizeConfidencePct(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const pct = raw >= 0 && raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// tradeability_pct is a second, independent 0-100 integer percent (see
// types.ts) with the exact same "AI sometimes returns a 0-1 fraction
// instead" failure mode and the exact same canonical fix — the same single
// normalization function is reused under its own name for clarity at call
// sites, never duplicated.
export const normalizeTradeabilityPct = normalizeConfidencePct;

// profitability_score is a third, independent 0-100 integer (see types.ts:
// the AI's own risk-adjusted-profitability ranking signal for "FIND BEST
// TRADES") with the exact same 0-1-fraction failure mode and fix.
export const normalizeProfitabilityScore = normalizeConfidencePct;
