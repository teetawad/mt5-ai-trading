type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
};

export function useApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.apiUrl || 'http://localhost:4000';

  async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
    const response = await $fetch<T>(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      body: options.body,
      credentials: 'include',
      headers: {
        'X-Request-ID': crypto.randomUUID(),
      },
    });
    return response as T;
  }

  return { apiFetch };
}
