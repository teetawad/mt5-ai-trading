import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMt5Bars } from '../services/mt5-client';
import { TradingEngineError } from '../services/trading-engine-client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('mt5-client engine error formatting', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TRADING_ENGINE_URL = 'http://localhost:8000';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the actual offending timeframe from a structured UNSUPPORTED_TIMEFRAME error', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, { detail: { error: 'UNSUPPORTED_TIMEFRAME', message: "Unsupported timeframe: 'H7'. Supported: M1, M5, M15, M30, H1, H4, D1" } }));
    await expect(getMt5Bars('EURUSD', 'H7', 200)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('H7'),
    });
    await expect(getMt5Bars('EURUSD', 'H7', 200)).rejects.toBeInstanceOf(TradingEngineError);
  });

  it('formats a structured SYMBOL_NOT_FOUND error with its code prefix', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { detail: { error: 'SYMBOL_NOT_FOUND', message: 'MT5 does not recognize symbol NOTASYMBOL' } }));
    await expect(getMt5Bars('NOTASYMBOL', 'M5', 200)).rejects.toMatchObject({
      status: 404,
      message: 'Trading engine MT5 error: 404 SYMBOL_NOT_FOUND: MT5 does not recognize symbol NOTASYMBOL',
    });
  });

  it('exposes the machine-readable code separately so callers can branch on it, not just parse the message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { detail: { error: 'PENDING_ORDER_NOT_CONFIRMED', message: 'no matching MT5 pending order was found' } }));
    await expect(getMt5Bars('EURUSD', 'M5', 200)).rejects.toMatchObject({
      status: 409,
      code: 'PENDING_ORDER_NOT_CONFIRMED',
    });
  });

  it('leaves code undefined for a legacy plain-string detail (nothing to branch on)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { detail: 'MetaTrader5 Python package or terminal is unavailable' }));
    await expect(getMt5Bars('EURUSD', 'M5', 200)).rejects.toMatchObject({ code: undefined });
  });

  it('leaves code and status undefined for a transport-level timeout — never mistaken for a definite rejection', async () => {
    fetchMock.mockImplementation(() => new Promise((_resolve, reject) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }));
    await expect(getMt5Bars('EURUSD', 'M5', 200)).rejects.toMatchObject({ code: undefined, status: undefined });
  });

  it('still handles a plain-string legacy detail shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { detail: 'MetaTrader5 Python package or terminal is unavailable' }));
    await expect(getMt5Bars('EURUSD', 'M5', 200)).rejects.toMatchObject({
      status: 503,
      message: 'Trading engine MT5 error: 503 MetaTrader5 Python package or terminal is unavailable',
    });
  });

  it('falls back to the raw body for a non-JSON error response without throwing a formatting error itself', async () => {
    fetchMock.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    await expect(getMt5Bars('EURUSD', 'M5', 200)).rejects.toMatchObject({ status: 500 });
  });

  it('succeeds and returns bars for M5/M15/H1/H4 once the timeframe is supported', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([{ time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, tick_volume: 100 }]), { status: 200 }));
    for (const timeframe of ['M5', 'M15', 'H1', 'H4']) {
      const bars = await getMt5Bars('EURUSD', timeframe, 200);
      expect(bars).toHaveLength(1);
    }
  });
});
