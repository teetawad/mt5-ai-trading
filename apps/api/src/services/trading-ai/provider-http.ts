// Shared 429 handling for every TradingAIProvider (openai-provider.ts,
// anthropic-provider.ts): distinguishes a genuinely transient "too many
// requests right now" rate limit (retryable with backoff) from real
// quota/billing exhaustion (retrying never helps) — see the regression this
// fixes in AiProviderRateLimitError's own doc comment. Never guesses: a 429
// is only ever treated as retryable when the provider's own error body says
// so; anything unrecognized is treated as non-retryable (the safer default —
// spinning retries against an error shape we don't understand risks masking
// a real, permanent failure behind a slow timeout instead of surfacing it).

export interface RateLimitClassification {
  retryable: boolean;
  message: string;
}

function lower(...values: Array<string | null | undefined>): string {
  return values.filter((v): v is string => Boolean(v)).join(' ').toLowerCase();
}

export function classifyRateLimitResponseBody(bodyText: string): RateLimitClassification {
  let code: string | null = null;
  let type: string | null = null;
  let message = bodyText.slice(0, 500);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; code?: string; type?: string } };
    code = parsed.error?.code ?? null;
    type = parsed.error?.type ?? null;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Not JSON — keep the raw text as the message; falls through to
    // non-retryable below since code/type stay null.
  }
  const needle = lower(code, type);
  const isQuota = needle.includes('quota') || needle.includes('insufficient') || needle.includes('billing') || needle.includes('credit');
  const isRateLimit = needle.includes('rate_limit') || needle.includes('rate limit') || needle.includes('overloaded');
  return { retryable: isRateLimit && !isQuota, message };
}

export function rateLimitRetryDelayMs(response: Response, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const retryAfterHeader = response.headers.get('retry-after');
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, maxDelayMs);
  }
  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const RATE_LIMIT_MAX_RETRIES = 2;
export const RATE_LIMIT_BASE_DELAY_MS = 500;
export const RATE_LIMIT_MAX_DELAY_MS = 10_000;
