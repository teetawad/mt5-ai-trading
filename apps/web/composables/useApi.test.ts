import { describe, expect, it } from 'vitest';
import { ApiError, normalizeApiError } from './useApi';

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
});
