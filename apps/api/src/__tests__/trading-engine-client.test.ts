import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMarketSnapshot,
  submitOrder,
  TradingEngineError,
} from '../services/trading-engine-client';

describe('trading engine client failure handling', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TRADING_ENGINE_URL = 'http://engine.test';
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.TRADING_ENGINE_URL;
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it('turns network failures into TradingEngineError', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(getMarketSnapshot('AAPL', 'network-failure')).rejects.toMatchObject({
      name: 'TradingEngineError',
      message: 'Trading engine unreachable: connect ECONNREFUSED',
    });
  });

  it('times out hung internal requests', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })
    ));

    const promise = getMarketSnapshot('AAPL', 'timeout-test');
    const assertion = expect(promise).rejects.toThrow('Trading engine request timed out');
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
  });

  it('submits paper orders with internal auth, request id, and idempotency key', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          broker_order_id: 'paper-1',
          status: 'FILLED',
          fills: [],
        }),
        { status: 200 },
      ),
    );

    await submitOrder(
      {
        idempotency_key: 'proposal:p1:attempt:1',
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '1.00000000',
        order_type: 'MARKET',
      },
      'submit-test',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://engine.test/broker/orders',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Internal-Token': 'internal-secret',
          'X-Request-ID': 'submit-test',
        }),
        body: expect.stringContaining('proposal:p1:attempt:1'),
      }),
    );
  });

  it('preserves non-OK internal response status', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(getMarketSnapshot('AAPL', 'bad-status')).rejects.toMatchObject({
      name: 'TradingEngineError',
      status: 503,
    } satisfies Partial<TradingEngineError>);
  });
});
