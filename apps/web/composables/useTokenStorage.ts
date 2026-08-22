import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// Only ever holds the short-lived session JWT (never a password or API key).
// SameSite=Strict cookies (see apps/api/src/routes/auth.ts) can't survive the
// cross-origin hop from a Capacitor WebView to the API host, so the native
// app authenticates via `Authorization: Bearer <token>` instead - a path the
// API already supports (apps/api/src/auth/middleware.ts extractToken()).
//
// Backed by the iOS Keychain (Android Keystore-backed SharedPreferences on
// Android) via @aparajita/capacitor-secure-storage - NOT @capacitor/preferences,
// which is plain UserDefaults with no encryption. On plain web this plugin's
// implementation falls back to unencrypted localStorage "for debugging
// purposes only" per its own docs, which is why every call here is gated
// behind isNative(): web builds never touch this at all and keep using the
// existing cookie + CSRF flow untouched.
//
// Never logged: no console.log/console.error in this file ever includes the
// token value itself, only success/failure of the operation. Cleared on
// logout (see useAuth.ts logout()) and restored on next app launch via
// getToken() (see useApi.ts apiFetch()).
const TOKEN_KEY = 'trade_session_token';

export function useTokenStorage() {
  const isNative = () => import.meta.client && Capacitor.isNativePlatform();

  async function getToken(): Promise<string | undefined> {
    if (!isNative()) return undefined;
    try {
      const value = await SecureStorage.getItem(TOKEN_KEY);
      return value ?? undefined;
    } catch {
      // Missing key / first launch / keychain read failure - treat all the
      // same as "no session", never surface the underlying error to the UI.
      return undefined;
    }
  }

  async function setToken(token: string): Promise<void> {
    if (!isNative()) return;
    await SecureStorage.setItem(TOKEN_KEY, token);
  }

  async function clearToken(): Promise<void> {
    if (!isNative()) return;
    try {
      await SecureStorage.removeItem(TOKEN_KEY);
    } catch {
      // Already absent - logout must never fail because there was nothing to clear.
    }
  }

  return { isNative, getToken, setToken, clearToken };
}
