import { App } from '@capacitor/app';

// On resume from background, re-verify the session and refetch whatever data
// the current page already declared via useAsyncData/useFetch - it never
// re-submits anything (no order/plan action lives in this path). Wired once
// from the default layout so every page benefits without per-page plumbing.
export function useAppLifecycle() {
  if (!import.meta.client) return;

  const { fetchCurrentUser } = useAuth();
  let listenerHandle: { remove: () => void } | undefined;

  onMounted(async () => {
    const sub = await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      fetchCurrentUser();
      refreshNuxtData();
    });
    listenerHandle = sub;
  });

  onUnmounted(() => {
    listenerHandle?.remove();
  });
}
