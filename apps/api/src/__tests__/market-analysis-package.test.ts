import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/mt5-client', () => ({
  getMt5Bars: vi.fn(),
  getMt5Status: vi.fn(),
  getMt5SymbolInfo: vi.fn(),
  getMt5Tick: vi.fn(),
  listMt5PendingOrders: vi.fn(),
  listMt5Positions: vi.fn(),
}));

import * as mt5Client from '../services/mt5-client';
import { buildMarketAnalysisPackage } from '../services/trading-ai/market-analysis';

function bar(i: number) {
  return { time: 1_700_000_000 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, tick_volume: 10 };
}

describe('buildMarketAnalysisPackage', () => {
  it('successfully requests M5 + M15 + H1 + H4 for a symbol without any timeframe rejection', async () => {
    vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: true, account: { balance: 10000, equity: 10000 } } as never);
    vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1900, ask: 1900.2, time: 1_700_003_600 } as never);
    vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue({ point: 0.01, digits: 2 } as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
    vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (_symbol, _timeframe, count) =>
      Array.from({ length: Math.min(count, 60) }, (_, i) => bar(i)),
    );

    const pkg = await buildMarketAnalysisPackage('XAUUSD', 'METAL');

    const requestedTimeframes = vi.mocked(mt5Client.getMt5Bars).mock.calls.map((call) => call[1]);
    expect(requestedTimeframes).toEqual(['M5', 'M15', 'H1', 'H4']);
    expect(pkg.timeframes).toHaveLength(4);
    for (const tf of pkg.timeframes) {
      expect(tf.barCount).toBeGreaterThan(0);
      expect(tf.close).not.toBeNull();
    }
  });

  it('does not fail the whole package when one timeframe legitimately has no bars yet', async () => {
    vi.mocked(mt5Client.getMt5Status).mockResolvedValue({ connected: true, demo_verified: true, account: {} } as never);
    vi.mocked(mt5Client.getMt5Tick).mockResolvedValue({ bid: 1900, ask: 1900.2 } as never);
    vi.mocked(mt5Client.getMt5SymbolInfo).mockResolvedValue({ point: 0.01 } as never);
    vi.mocked(mt5Client.listMt5Positions).mockResolvedValue([]);
    vi.mocked(mt5Client.listMt5PendingOrders).mockResolvedValue([]);
    vi.mocked(mt5Client.getMt5Bars).mockImplementation(async (_symbol, timeframe) =>
      timeframe === 'M5' ? [] : [bar(0), bar(1)],
    );

    const pkg = await buildMarketAnalysisPackage('XAUUSD', 'METAL');
    const m5 = pkg.timeframes.find((tf) => tf.timeframe === 'M5');
    expect(m5?.barCount).toBe(0);
    expect(m5?.close).toBeNull();
    expect(pkg.timeframes).toHaveLength(4);
  });
});
