type AuthUser = {
  id: string;
  email: string;
  role: string;
  displayName?: string;
};

type LoginResponse = {
  user: AuthUser;
  sessionToken: string;
  csrfToken: string;
};

type LoginCredentials = {
  email: string;
  password: string;
};

function clearReadableCookie(name: string) {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Strict`;
}

export function useAuth() {
  const { apiFetch } = useApi();
  const user = useState<AuthUser | null>('auth:user', () => null);
  const checked = useState<boolean>('auth:checked', () => false);

  const isAuthenticated = computed(() => Boolean(user.value));

  async function fetchCurrentUser(): Promise<AuthUser | null> {
    try {
      const currentUser = await apiFetch<AuthUser>('/auth/me');
      user.value = currentUser;
      return currentUser;
    } catch (error) {
      user.value = null;
      return null;
    } finally {
      checked.value = true;
    }
  }

  async function login(credentials: LoginCredentials): Promise<AuthUser> {
    const response = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: credentials,
    });
    user.value = response.user;
    checked.value = true;
    return response.user;
  }

  async function logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      user.value = null;
      checked.value = true;
      clearReadableCookie('csrf_token');
      await navigateTo('/login');
    }
  }

  return {
    user,
    checked,
    isAuthenticated,
    fetchCurrentUser,
    login,
    logout,
  };
}
