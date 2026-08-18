import { computed, ref } from 'vue';

// State machine for the owner-approved "Trade in Demo" flow. Kept as a
// plain composable (no component/DOM coupling) so the execution logic -
// the part that actually matters for correctness - is directly unit
// testable without a browser/DOM environment.
export type TradeExecutionState = 'idle' | 'sending' | 'success' | 'failed';

export interface TradeExecutionOutcome {
  success?: boolean;
  mt5Confirmed?: boolean;
  code?: string | null;
  message?: string | null;
  symbol?: string | null;
  side?: string | null;
  ticket?: string | null;
  orderTicket?: string | null;
  dealTicket?: string | null;
  volume?: string | number | null;
  actualEntry?: string | number | null;
  stopLoss?: string | number | null;
  takeProfit?: string | number | null;
  openedAt?: string | null;
  details?: unknown;
}

export type TradeApiFetch = <T>(path: string, options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' }) => Promise<T>;

export function useTradeExecution(apiFetch: TradeApiFetch) {
  const state = ref<TradeExecutionState>('idle');
  const outcome = ref<TradeExecutionOutcome | null>(null);

  const inFlight = computed(() => state.value === 'sending');

  function reset() {
    state.value = 'idle';
    outcome.value = null;
  }

  async function execute(symbol: string): Promise<TradeExecutionOutcome> {
    // Guard against duplicate clicks / re-entrant calls: a request for this
    // modal instance is already in flight, never fire a second one.
    if (inFlight.value) {
      return outcome.value ?? { success: false, mt5Confirmed: false, code: 'ALREADY_IN_PROGRESS', message: 'A request is already in progress.' };
    }
    state.value = 'sending';
    outcome.value = null;
    try {
      // This one request covers the entire backend chain (risk re-check ->
      // DemoExecutionGateway -> order_check -> order_send -> positions_get()
      // confirmation) - there is no intermediate progress event to
      // subscribe to, so `sending` is genuinely the only in-flight state; it
      // is never advanced early or faked before the real response arrives.
      const response = await apiFetch<TradeExecutionOutcome>(`/mt5/assisted-demo/${encodeURIComponent(symbol)}`, { method: 'POST' });
      outcome.value = response;
      // MT5 is the only source of truth: success is only ever shown when the
      // backend has already confirmed a real position via positions_get() -
      // both flags, never a bare HTTP 2xx or a DB-insert-only signal.
      state.value = response?.success === true && response?.mt5Confirmed === true ? 'success' : 'failed';
      return response;
    } catch (error) {
      const failure: TradeExecutionOutcome = {
        success: false,
        mt5Confirmed: false,
        code: 'REQUEST_FAILED',
        message: error instanceof Error ? error.message : 'The request failed before a response was received.',
      };
      outcome.value = failure;
      state.value = 'failed';
      return failure;
    }
  }

  return { state, outcome, inFlight, execute, reset };
}
