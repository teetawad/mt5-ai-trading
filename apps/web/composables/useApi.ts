type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;

  const prefix = `${name}=`;
  const cookie = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(prefix));

  if (!cookie) return undefined;
  return decodeURIComponent(cookie.slice(prefix.length));
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

    const response = await $fetch<T>(`${baseUrl}${path}`, {
      method,
      body: options.body,
      credentials: 'include',
      headers,
    });
    return response as T;
  }

  return { apiFetch };
}
