import { describe, expect, it, vi } from 'vitest';
import { useTradeExecution } from './useTradeExecution';

describe('useTradeExecution', () => {
  it('starts idle and never calls the API until execute() is invoked (cancel does not call the API)', () => {
    const apiFetch = vi.fn();
    const { state, execute: _execute } = useTradeExecution(apiFetch);
    void _execute; // acknowledge unused-in-this-test export, cancel is simply never calling it
    expect(state.value).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('confirm calls the assisted-demo execution endpoint for the given symbol, never auto-demo', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: true, mt5Confirmed: true, ticket: '123' });
    const { execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/mt5/assisted-demo/LTCUSD', { method: 'POST' });
  });

  it('goes idle -> sending -> success only when both success and mt5Confirmed are true', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const apiFetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const { state, execute } = useTradeExecution(apiFetch);
    const promise = execute('LTCUSD');
    expect(state.value).toBe('sending');
    resolveFetch({ success: true, mt5Confirmed: true, ticket: '472240870' });
    await promise;
    expect(state.value).toBe('success');
  });

  it('a second execute() call while one is already in flight is ignored (loading state prevents duplicate clicks)', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const apiFetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    const { execute } = useTradeExecution(apiFetch);
    const first = execute('LTCUSD');
    const second = execute('LTCUSD'); // fired while `first` is still pending
    resolveFetch({ success: true, mt5Confirmed: true, ticket: '1' });
    await Promise.all([first, second]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('a Risk Engine rejection surfaces the exact code and message, never a generic string', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      success: false,
      mt5Confirmed: false,
      code: 'SPREAD_TOO_HIGH',
      message: 'Spread is currently above your configured maximum.',
    });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
    expect(outcome.value?.code).toBe('SPREAD_TOO_HIGH');
    expect(outcome.value?.message).not.toMatch(/^Risk Engine rejected$/);
  });

  it('an order_check failure surfaces ORDER_CHECK_FAILED and shows the failed state', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: false, mt5Confirmed: false, code: 'ORDER_CHECK_FAILED', message: 'MT5 rejected the request.' });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
    expect(outcome.value?.code).toBe('ORDER_CHECK_FAILED');
  });

  it('an order_send failure surfaces EXECUTION_UNCONFIRMED and shows the failed state', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: false, mt5Confirmed: false, code: 'EXECUTION_UNCONFIRMED', message: 'MT5 did not confirm the order.' });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
    expect(outcome.value?.code).toBe('EXECUTION_UNCONFIRMED');
  });

  it('never shows success when the backend reports executed but not MT5-confirmed', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: true, mt5Confirmed: false, code: null, message: null });
    const { state, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
  });

  it('never shows success when mt5Confirmed is true but success is not (defensive - should not happen, but never trust one flag alone)', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: false, mt5Confirmed: true });
    const { state, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
  });

  it('a confirmed MT5 position produces a success outcome containing the real MT5 ticket and trade details', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      success: true,
      mt5Confirmed: true,
      symbol: 'LTCUSD',
      side: 'SELL',
      ticket: '472240870',
      orderTicket: '472240870',
      dealTicket: '363507775',
      volume: '0.01',
      actualEntry: '43.79',
      stopLoss: '45.29',
      takeProfit: '42.29',
      openedAt: '2026-08-17T08:25:47.846Z',
    });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('success');
    expect(outcome.value?.ticket).toBe('472240870');
    expect(outcome.value?.dealTicket).toBe('363507775');
  });

  it('a network/unexpected failure (no response at all) still resolves to a clear failed state, never leaves the UI hanging', async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
    expect(outcome.value?.code).toBeTruthy();
  });

  it('reset() returns to idle so the modal can be reopened for another attempt', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ success: true, mt5Confirmed: true });
    const { state, execute, reset } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('success');
    reset();
    expect(state.value).toBe('idle');
  });

  it('a duplicate/second click after the plan already executed reports ALREADY_EXECUTED with the real MT5 ticket, not a generic ALREADY_PROCESSING', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      success: false,
      mt5Confirmed: false,
      code: 'ALREADY_EXECUTED',
      message: 'This entry plan already executed in MT5 (ticket 472240870).',
      ticket: '472240870',
      orderTicket: '472240870',
    });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed'); // not a fresh success, but a distinct informational outcome the UI branches on
    expect(outcome.value?.code).toBe('ALREADY_EXECUTED');
    expect(outcome.value?.code).not.toBe('ALREADY_PROCESSING');
    expect(outcome.value?.ticket).toBe('472240870');
  });

  it('an in-flight duplicate reports EXECUTION_IN_PROGRESS, not a generic rejection', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      success: false,
      mt5Confirmed: false,
      code: 'EXECUTION_IN_PROGRESS',
      message: 'This entry plan is already being executed.',
    });
    const { state, outcome, execute } = useTradeExecution(apiFetch);
    await execute('LTCUSD');
    expect(state.value).toBe('failed');
    expect(outcome.value?.code).toBe('EXECUTION_IN_PROGRESS');
  });
});
