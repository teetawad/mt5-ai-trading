import { Network } from '@capacitor/network';

// Device-level connectivity only ("API OFFLINE" style banner) - this is
// deliberately generic, not per-service (trading engine / MT5 / AI provider
// already surface their own specific status on the pages that call those
// endpoints, e.g. apps/web/pages/ai-trade.vue). Falls back to
// navigator.onLine + window online/offline events on plain web, where
// @capacitor/network's browser implementation already does exactly that.
export function useNetworkStatus() {
  const isOnline = useState<boolean>('network:online', () => true);

  async function refresh() {
    if (!import.meta.client) return;
    const status = await Network.getStatus();
    isOnline.value = status.connected;
  }

  if (import.meta.client) {
    let listenerHandle: { remove: () => void } | undefined;
    onMounted(async () => {
      await refresh();
      const sub = await Network.addListener('networkStatusChange', (status) => {
        isOnline.value = status.connected;
      });
      listenerHandle = sub;
    });
    onUnmounted(() => {
      listenerHandle?.remove();
    });
  }

  return { isOnline, refresh };
}
