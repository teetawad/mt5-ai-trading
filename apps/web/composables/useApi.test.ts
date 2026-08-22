import { describe, expect, it } from 'vitest';
import { ApiError, normalizeApiError, validateMobileApiUrl } from './useApi';

// Root-cause coverage for the PATCH /mt5/watchlist 401 bug report: the fix
// is that every apiFetch() failure is normalized into a plain-language
// ApiError before it ever reaches a component, so a raw
// `[PATCH] "http://localhost:4000/mt5/watchlist": 401 Unauthorized` string
// can never be shown to a beginner user.
describe('normalizeApiError', () => {
  function fakeFetchError(status: number, data: Record<string, unknown>) {
    return { response: { status, _data: data }, data };
  }

  it('UNAUTHENTICATED (expired/missing session cookie) becomes a friendly SESSION_EXPIRED error, never the raw status text', () => {
    const err = fakeFetchError(401, { error: 'UNAUTHENTICATED', message: 'Invalid or expired session token' });
    const result = normalizeApiError(err);
    expect(result).toBeInstanceOf(ApiError);
    expect(result.code).toBe('SESSION_EXPIRED');
    expect(result.message).toBe('Your session has expired. Please sign in again.');
    expect(result.message).not.toMatch(/401|Unauthorized/i);
  });

  it('an invalid CSRF token (session cookie present but stale) is also treated as a session expiry, not a raw CSRF error', () => {
    const err = fakeFetchError(403, { error: 'CSRF_TOKEN_INVALID', message: 'Missing or invalid CSRF token' });
    const result = normalizeApiError(err);
    expect(result.code).toBe('SESSION_EXPIRED');
    expect(result.message).toBe('Your session has expired. Please sign in again.');
  });

  it('a wrong-password /auth/login failure is NOT relabeled as a session expiry, even though it is also HTTP 401', () => {
    const err = fakeFetchError(401, { error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    const result = normalizeApiError(err);
    expect(result.code).not.toBe('SESSION_EXPIRED');
    expect(result.code).toBe('INVALID_CREDENTIALS');
    expect(result.message).toBe('Invalid email or password');
  });

  it('a real 403 FORBIDDEN (e.g. non-owner role) keeps its own message, distinct from a session expiry', () => {
    const err = fakeFetchError(403, { error: 'FORBIDDEN', message: 'Owner role required' });
    const result = normalizeApiError(err);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).toBe('Owner role required');
  });

  it('any other backend error with a message is passed through as plain language, with its own code', () => {
    const err = fakeFetchError(422, { error: 'INVALID_WATCHLIST_UPDATE', message: 'symbols[] and enabled are required' });
    const result = normalizeApiError(err);
    expect(result.code).toBe('INVALID_WATCHLIST_UPDATE');
    expect(result.message).toBe('symbols[] and enabled are required');
  });

  it('a response with no usable backend message still produces a plain-language fallback, never a raw fetch error string', () => {
    const result = normalizeApiError(new Error('[PATCH] "http://localhost:4000/mt5/watchlist": 500 Internal Server Error'));
    expect(result.message).toBe('Something went wrong. Please try again.');
    expect(result.message).not.toMatch(/PATCH|localhost|Internal Server Error/i);
  });

  // Regression coverage for GET /mt5/ai-trade/top-opportunities: the API now
  // returns a precise 503 body ({error: 'TOP_OPPORTUNITIES_UNAVAILABLE', ...})
  // instead of a generic MT5_BACKEND_ERROR — confirm that exact code/message
  // survives normalization unchanged, never swallowed into a generic fallback.
  it('preserves a precise upstream-unavailable code/message (e.g. TOP_OPPORTUNITIES_UNAVAILABLE), never a generic fallback', () => {
    const err = fakeFetchError(503, { error: 'TOP_OPPORTUNITIES_UNAVAILABLE', message: 'AI opportunities are temporarily unavailable.' });
    const result = normalizeApiError(err);
    expect(result.code).toBe('TOP_OPPORTUNITIES_UNAVAILABLE');
    expect(result.message).toBe('AI opportunities are temporarily unavailable.');
    expect(result.status).toBe(503);
  });

  // Section 5/6 regression guard: normalizeApiError's return value must
  // always be a plain-data-safe object (message: string, code: string,
  // status: number|null) — never carrying a reference to the raw
  // FetchError/Response/Headers it was built from. This is exactly what
  // makes it safe to log/store without ever risking the "DevalueError:
  // Cannot stringify arbitrary non-POJOs" Nuxt dev-log serialization
  // failure this bug produced.
  it('never carries the raw Response/Headers/FetchError through — only plain, JSON-safe fields', () => {
    const rawResponse = new Response(null, { status: 503, headers: { 'x-test': '1' } });
    const err = { response: { status: 503, _data: { error: 'X', message: 'Y' }, raw: rawResponse }, data: { error: 'X', message: 'Y' } };
    const result = normalizeApiError(err);

    expect(typeof result.message).toBe('string');
    expect(result.message).toBe('Y');
    expect(typeof result.code).toBe('string');
    expect(result.code).toBe('X');
    expect(result.status === null || typeof result.status === 'number').toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
    // The one field that would actually break devalue/JSON serialization —
    // never present anywhere on the normalized result, even indirectly.
    expect(Object.values(result).some((v) => v instanceof Response || v instanceof Headers)).toBe(false);
  });
});

// Section 10 (production API) regression coverage: a Capacitor build must
// never silently ship pointed at plain HTTP - see nuxt.config.ts's build-time
// guard (same logic, duplicated at build time for a build to fail loud
// immediately rather than only when someone opens the app).
describe('validateMobileApiUrl', () => {
  it('rejects a missing API URL', () => {
    expect(() => validateMobileApiUrl(undefined, false)).toThrow(/NUXT_PUBLIC_API_URL is not set/);
  });

  it('accepts an https:// URL without needing the insecure opt-in', () => {
    expect(() => validateMobileApiUrl('https://api.example.com', false)).not.toThrow();
  });

  it('rejects a plain-HTTP LAN URL by default', () => {
    expect(() => validateMobileApiUrl('http://192.168.1.50:4000', false)).toThrow(/must be an https:\/\/ URL/);
  });

  it('rejects plain localhost by default', () => {
    expect(() => validateMobileApiUrl('http://localhost:4000', false)).toThrow(/must be an https:\/\/ URL/);
  });

  it('allows a plain-HTTP LAN URL only with the explicit dev opt-in', () => {
    expect(() => validateMobileApiUrl('http://192.168.1.50:4000', true)).not.toThrow();
  });
});
