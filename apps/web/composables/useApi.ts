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

// Shared by the runtime guard below and the build-time guard in
// nuxt.config.ts (which fails `nuxt generate` immediately, before ever
// producing a bundle that would silently ship a plain-HTTP production
// config). Kept as a plain function - no Nuxt auto-imports - so it's
// directly unit-testable (see useApi.test.ts).
export function validateMobileApiUrl(apiUrl: string | undefined, allowInsecure: boolean): void {
  // "localhost" inside a native WebView/simulator resolves to the device
  // itself, not the dev machine - never fall back to it silently.
  if (!apiUrl) {
    throw new Error(
      'NUXT_PUBLIC_API_URL is not set. The iOS build must be given a real reachable API URL at build time (LAN IP for device testing, HTTPS domain for production) - it cannot fall back to localhost.',
    );
  }
  if (!apiUrl.startsWith('https://') && !allowInsecure) {
    throw new Error(
      `NUXT_PUBLIC_API_URL (${apiUrl}) must be an https:// URL for a Capacitor build. Plain HTTP (including a LAN IP) is development-only: set NUXT_PUBLIC_ALLOW_INSECURE_MOBILE_API=true explicitly for LAN device testing, and never for a production build.`,
    );
  }
}

export function useApi() {
  const config = useRuntimeConfig();

  // The plain web build keeps the existing dev-convenience localhost
  // fallback and has no HTTPS requirement (same-origin/LAN dev as today).
  if (config.public.buildTarget === 'capacitor') {
    validateMobileApiUrl(config.public.apiUrl, config.public.allowInsecureMobileApi === true);
  }
  const baseUrl = config.public.apiUrl || 'http://localhost:4000';

  const { isNative, getToken, clearToken } = useTokenStorage();

  async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'X-Request-ID': globalThis.crypto.randomUUID(),
    };

    // Native builds: Bearer token only, no cookie/CSRF - SameSite=Strict
    // cookies don't survive the cross-origin hop, and the API's CSRF check
    // is already skipped whenever there's no session cookie (see
    // apps/api/src/auth/csrf.ts), so a bare bearer token is the full story.
    if (isNative()) {
      const token = await getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    } else {
      const csrfToken = readCookie('csrf_token');
      if (UNSAFE_METHODS.has(method) && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    if (import.meta.server) {
      const cookie = useRequestHeaders(['cookie']).cookie;
      if (cookie) headers.cookie = cookie;
    }

    try {
      const response = await $fetch(`${baseUrl}${path}`, {
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
        if (isNative()) clearToken();
      }
      // Technical detail stays in the dev console; UI only ever sees the
      // normalized, plain-language ApiError above. Deliberately a plain
      // object literal, NEVER the raw caught `err` (an ofetch FetchError
      // wrapping a Response/Headers) or the `normalized` ApiError instance
      // itself: during SSR, Nuxt's dev server forwards console.error
      // arguments to the browser devtools using devalue, which can only
      // serialize plain objects/primitives — passing a non-POJO here is
      // exactly what produced "DevalueError: Cannot stringify arbitrary
      // non-POJOs" (a logging-noise symptom of this, not the real bug).
      if (import.meta.dev) {
        console.error(`[apiFetch] ${method} ${path} failed:`, {
          status: normalized.status,
          code: normalized.code,
          message: normalized.message,
        });
      }
      throw normalized;
    }
  }

  return { apiFetch };
}
