import {
  AiPlanValidationError,
  AiProviderAuthError,
  AiProviderBillingError,
  AiProviderRateLimitError,
  AiRequestTimeoutError,
  AiResponseInvalidError,
  AiUnknownSymbolError,
} from './types';

// Owner-reported regression: a "FIND BEST TRADES" scan across 20 shortlisted
// symbols came back with "Valid trade plans: 0 / Technical blocked: 20" —
// every one of those 20 rows was actually an AI PROVIDER failure (OpenAI
// returned 429 on every request; see AiProviderRateLimitError's own doc
// comment), not a genuine "AI could not construct a valid plan" outcome, but
// the scanner's error handling collapsed every thrown exception into one
// undifferentiated "Technical blocked" bucket (spec: "Do NOT collapse all
// failures into Technical blocked"). This module gives every thrown
// exception from analyzeSymbolWithAI an exact, stable code so the scan
// summary can report AI PROVIDER ERRORS separately from genuine technical
// plan-validation failures, and so a row can always say exactly why it
// isn't a valid plan.

// AI-provider-layer failures — the AI service itself could not be reached,
// authenticated, or billed, or its response could not be parsed at all.
// Never a statement about whether the underlying trade setup was good or
// bad; retrying later (or fixing the account/config) is what resolves these,
// not adjusting the plan.
export const AI_PROVIDER_ERROR_CODES = [
  'AI_PROVIDER_AUTH_FAILED',
  'AI_PROVIDER_RATE_LIMITED',
  'AI_PROVIDER_QUOTA_EXCEEDED',
  'AI_PROVIDER_TIMEOUT',
  'AI_RESPONSE_INVALID',
] as const;
export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number];
// Includes AI_PROVIDER_NOT_CONFIGURED (missing API key/config) alongside the
// thrown-exception provider codes above — same "provider-layer, not a plan
// validity problem" bucket for the scan summary, even though it never
// throws (getTradingAIProvider() surfaces it as a plain return value; see
// trading-ai-service.ts's analyzeSymbolWithAI).
export const AI_PROVIDER_ERROR_CODE_SET: ReadonlySet<string> = new Set([...AI_PROVIDER_ERROR_CODES, 'AI_PROVIDER_NOT_CONFIGURED']);

// Genuine technical plan-validation failures — the AI responded, but no
// valid, executable plan could be built from what it returned (or, for
// SYMBOL_NOT_IN_CATALOG, the request should never have reached the AI at
// all). See decision-policy.ts's own NO_EXECUTION reasons for
// NO_ACTIONABLE_PLAN/MARKET_CLOSED/STALE_QUOTE/CONTRADICTORY_PLAN, which
// share this same code space.
export type TechnicalBlockCode =
  | AiProviderErrorCode
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SYMBOL_NOT_IN_CATALOG'
  | 'NO_ACTIONABLE_PLAN'
  | 'MARKET_CLOSED'
  | 'STALE_QUOTE'
  | 'CONTRADICTORY_PLAN'
  | 'UNKNOWN_ERROR';

export interface ClassifiedAiFailure {
  isProviderError: boolean;
  technicalBlockCode: TechnicalBlockCode;
  message: string;
}

export function classifyAiFailure(err: unknown): ClassifiedAiFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AiProviderAuthError) return { isProviderError: true, technicalBlockCode: 'AI_PROVIDER_AUTH_FAILED', message };
  if (err instanceof AiProviderRateLimitError) return { isProviderError: true, technicalBlockCode: 'AI_PROVIDER_RATE_LIMITED', message };
  if (err instanceof AiProviderBillingError) return { isProviderError: true, technicalBlockCode: 'AI_PROVIDER_QUOTA_EXCEEDED', message };
  if (err instanceof AiRequestTimeoutError) return { isProviderError: true, technicalBlockCode: 'AI_PROVIDER_TIMEOUT', message };
  if (err instanceof AiResponseInvalidError) return { isProviderError: true, technicalBlockCode: 'AI_RESPONSE_INVALID', message };
  if (err instanceof AiPlanValidationError) {
    return { isProviderError: false, technicalBlockCode: 'SCHEMA_VALIDATION_FAILED', message: `${message}: ${err.issues.join('; ')}` };
  }
  if (err instanceof AiUnknownSymbolError) return { isProviderError: false, technicalBlockCode: 'SYMBOL_NOT_IN_CATALOG', message };
  return { isProviderError: false, technicalBlockCode: 'UNKNOWN_ERROR', message };
}

// Maps decision-policy.ts's own NO_EXECUTION reasons onto the same
// TechnicalBlockCode space, so a successfully-parsed-but-non-actionable AI
// result (the AI itself reported no plan, or a MARKET_NOW couldn't be
// entered right now) and a thrown-exception failure both show up in the
// exact same "technical block breakdown" the owner asked for — never two
// parallel, inconsistent taxonomies.
const NO_EXECUTION_BLOCK_CODES: Record<string, TechnicalBlockCode> = {
  NO_VALID_ENTRY: 'NO_ACTIONABLE_PLAN',
  MARKET_CLOSED: 'MARKET_CLOSED',
  STALE_QUOTE: 'STALE_QUOTE',
  CONTRADICTORY_PLAN: 'CONTRADICTORY_PLAN',
};

export interface TechnicalStatus {
  technicalValid: boolean;
  technicalBlockCode: TechnicalBlockCode | null;
  technicalBlockMessage: string | null;
}

export function technicalStatusForAction(action: string | null, actionReason: string | null): TechnicalStatus {
  if (action === 'ENTER_NOW' || action === 'WAIT_FOR_ENTRY') {
    return { technicalValid: true, technicalBlockCode: null, technicalBlockMessage: null };
  }
  if (action === 'NO_EXECUTION') {
    const code = (actionReason && NO_EXECUTION_BLOCK_CODES[actionReason]) || 'NO_ACTIONABLE_PLAN';
    return { technicalValid: false, technicalBlockCode: code, technicalBlockMessage: actionReason };
  }
  // action === null: caller never reached decision-policy.ts at all (an
  // exception was thrown) — see classifyAiFailure, applied separately by the
  // caller since only it has the actual caught error.
  return { technicalValid: false, technicalBlockCode: null, technicalBlockMessage: null };
}
