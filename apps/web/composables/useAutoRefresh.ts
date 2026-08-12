/**
 * Polls an existing refresh function on an interval so a page's data stays
 * live without a manual reload. Reuses whatever REST endpoint the page
 * already calls via useAsyncData — this does not open any new connection,
 * it just re-fetches on a timer. Paused while the tab is hidden.
 */
export function useAutoRefresh(refresh: () => unknown, intervalMs = 5000): void {
  if (import.meta.server) return;

  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refresh();
  }

  onMounted(() => {
    timer = setInterval(tick, intervalMs);
  });

  onUnmounted(() => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
