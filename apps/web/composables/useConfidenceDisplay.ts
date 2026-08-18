// The API always sends confidence_pct as an already-normalized 0-100 integer
// (see apps/api/src/services/trading-ai/confidence.ts). The frontend must
// never re-derive or re-scale it — just render the whole percent as-is.
export function formatConfidencePct(confidencePct: number | null | undefined): string {
  if (confidencePct === null || confidencePct === undefined || !Number.isFinite(confidencePct)) return '-';
  return `${confidencePct}%`;
}
