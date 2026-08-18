type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Normalized shape every apiFetch() rejection carries, so callers never have
// to parse ofetch's raw "[PATCH] \"http://...\": 401 Unauthorized" string to
// decide what to show a beginner user. `code` lets a component branch on a
// specific case (e.g. SESSION_EXPIRED -> offer a "Sign In Again" button)
// without string-matching a human message.
export class ApiError extends Error {
  code: string;
  status: number | null;

  constructor(message: string, code: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;

  const prefix = `${name}=`;
  const cookie = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(prefix));

  if (!cookie) return undefined;
  return decodeURIComponent(cookie.slice(prefix.length));
}

export function normalizeApiError(err: unknown): ApiError {
  const fetchError = err as { response?: { status?: number; _data?: unknown }; statusCode?: number; data?: unknown } | null;
  const status = fetchError?.response?.status ?? fetchError?.statusCode ?? null;
  const data = (fetchError?.data ?? fetchError?.response?._data) as { error?: string; message?: string } | undefined;

  // Keyed off the backend's own error code, not just the HTTP status: a 401
  // from a WRONG PASSWORD on /auth/login is also status 401 but must keep
  // its own message ("Invalid email or password"), not be relabeled as a
  // session expiry. UNAUTHENTICATED (requireAuth/requireOwner) and an
  // invalid CSRF token, though, both mean the same thing to a beginner user
  // on an already-authenticated page: the session cookie expired (it
  // carries a hard maxAge — see apps/api/src/routes/auth.ts) or was
  // invalidated server-side. This exact endpoint/header/credentials
  // combination is verified working when the session is valid.
  if (status === 401 && data?.error === 'UNAUTHENTICATED') {
    return new ApiError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED', 401);
  }
  if (status === 403 && data?.error === 'CSRF_TOKEN_INVALID') {
    return new ApiError('Your session has expired. Please sign in again.', 'SESSION_EXPIRED', 403);
  }
  if (status === 403) {
    return new ApiError(data?.message ?? 'You do not have permission to do that.', data?.error ?? 'FORBIDDEN', 403);
  }
  if (typeof data?.message === 'string' && data.message) {
    return new ApiError(data.message, data.error ?? 'REQUEST_FAILED', status);
  }
  return new ApiError('Something went wrong. Please try again.', 'REQUEST_FAILED', status);
}

export function useApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.apiUrl || 'http://localhost:4000';

  async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'X-Request-ID': globalThis.crypto.randomUUID(),
    };
    const csrfToken = readCookie('csrf_token');

    if (UNSAFE_METHODS.has(method) && csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    if (import.meta.server) {
      const cookie = useRequestHeaders(['cookie']).cookie;
      if (cookie) headers.cookie = cookie;
    }

    try {
      const response = await $fetch<T>(`${baseUrl}${path}`, {
        method,
        body: options.body,
        credentials: 'include',
        headers,
      });
      return response as T;
    } catch (err) {
      const normalized = normalizeApiError(err);
      if (normalized.code === 'SESSION_EXPIRED') {
        // Best-effort, synchronous local sign-out: the next full navigation
        // (or the caller's own "Sign In Again" button) already goes through
        // the existing auth.global.ts redirect - this just makes sure nav
        // guard sees a logged-out state immediately rather than stale
        // cached user info from before the session actually expired.
        const authUser = useState<{ id: string } | null>('auth:user', () => null);
        authUser.value = null;
      }
      // Technical detail stays in the dev console; UI only ever sees the
      // normalized, plain-language ApiError above.
      if (import.meta.dev) {
        console.error(`[apiFetch] ${method} ${path} failed:`, err);
      }
      throw normalized;
    }
  }

  return { apiFetch };
}
