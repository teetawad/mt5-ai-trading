import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { signToken } from '../auth/tokens';
import { _clearDenylistForTest } from '../auth/denylist';

// Mock the trading engine client module
vi.mock('../services/trading-engine-client', () => ({
  TradingEngineError: class TradingEngineError extends Error {
    constructor(msg: string, public status?: number) {
      super(msg);
      this.name = 'TradingEngineError';
    }
  },
  getMarketSnapshot: vi.fn(),
  getAllMarketSnapshots: vi.fn(),
  getHistoricalBars: vi.fn(),
  getLatestQuote: vi.fn(),
  getLatestTrade: vi.fn(),
  getTrackedSymbols: vi.fn(),
}));

import {
  getMarketSnapshot,
  getAllMarketSnapshots,
  getHistoricalBars,
  getLatestQuote,
  getLatestTrade,
  getTrackedSymbols,
  TradingEngineError,
} from '../services/trading-engine-client';

const FAKE_SNAPSHOT = {
  symbol: 'AAPL',
  price: '175.00000000',
  bid: '174.91250000',
  ask: '175.08750000',
  volume: 45321,
  timestamp: '2024-01-15T10:30:00.000Z',
  is_stale: false,
};

function makeToken() {
  process.env.SESSION_SECRET = 'test-secret-market-data';
  return signToken({ sub: 'user-1', email: 'o@t.com', role: 'owner' });
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearDenylistForTest();
});

describe('GET /market-data/snapshot/:symbol', () => {
  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/market-data/snapshot/AAPL');
    expect(res.status).toBe(401);
  });

  it('returns 200 with snapshot data', async () => {
    vi.mocked(getMarketSnapshot).mockResolvedValue(FAKE_SNAPSHOT);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshot/AAPL')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('AAPL');
    expect(res.body.price).toBe('175.00000000');
    expect(res.body.isStale).toBe(false);
    expect(res.body.is_stale).toBeUndefined();
  });

  it('normalises symbol to uppercase', async () => {
    vi.mocked(getMarketSnapshot).mockResolvedValue({ ...FAKE_SNAPSHOT, symbol: 'AAPL' });
    const app = createApp();
    await request(app)
      .get('/market-data/snapshot/aapl')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(vi.mocked(getMarketSnapshot)).toHaveBeenCalledWith('AAPL', undefined);
  });

  it('returns 404 when symbol not found', async () => {
    vi.mocked(getMarketSnapshot).mockResolvedValue(null);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshot/ZZZZZ')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 for invalid symbol format', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshot/TOOLONGSYMBOL!!!')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 503 when trading engine is unreachable', async () => {
    vi.mocked(getMarketSnapshot).mockRejectedValue(
      new TradingEngineError('Trading engine unreachable'),
    );
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshot/AAPL')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('GET /market-data/snapshots', () => {
  it('requires authentication', async () => {
    const app = createApp();
    const res = await request(app).get('/market-data/snapshots');
    expect(res.status).toBe(401);
  });

  it('returns list of all snapshots', async () => {
    vi.mocked(getAllMarketSnapshots).mockResolvedValue([
      FAKE_SNAPSHOT,
      { ...FAKE_SNAPSHOT, symbol: 'MSFT', price: '380.00000000' },
    ]);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshots')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].symbol).toBe('AAPL');
    expect(res.body[1].symbol).toBe('MSFT');
    // is_stale renamed to isStale
    expect(res.body[0].isStale).toBeDefined();
    expect(res.body[0].is_stale).toBeUndefined();
  });

  it('returns 503 when trading engine is unreachable', async () => {
    vi.mocked(getAllMarketSnapshots).mockRejectedValue(
      new TradingEngineError('unreachable'),
    );
    const app = createApp();
    const res = await request(app)
      .get('/market-data/snapshots')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(503);
  });
});

describe('GET /market-data/symbols', () => {
  it('returns list of tracked symbols', async () => {
    vi.mocked(getTrackedSymbols).mockResolvedValue(['AAPL', 'MSFT', 'GOOGL']);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/symbols')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['AAPL', 'MSFT', 'GOOGL']);
  });
});

describe('GET /market-data/bars/:symbol', () => {
  it('returns historical bars', async () => {
    vi.mocked(getHistoricalBars).mockResolvedValue([
      {
        symbol: 'AAPL',
        open: '190.00000000',
        high: '192.00000000',
        low: '189.00000000',
        close: '191.00000000',
        volume: 1000,
        timestamp: '2026-08-10T13:30:00Z',
        trade_count: 42,
        vwap: '190.75000000',
      },
    ]);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/bars/aapl?timeframe=1Min&start=2026-08-10T13:30:00Z&limit=1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body[0].symbol).toBe('AAPL');
    expect(res.body[0].tradeCount).toBe(42);
    expect(res.body[0].trade_count).toBeUndefined();
    expect(vi.mocked(getHistoricalBars)).toHaveBeenCalledWith(
      'AAPL',
      {
        timeframe: '1Min',
        start: '2026-08-10T13:30:00Z',
        end: undefined,
        limit: 1,
      },
      undefined,
    );
  });

  it('validates required bar query fields', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/market-data/bars/AAPL?timeframe=1Min')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(422);
  });

  it('propagates market data rate limits', async () => {
    vi.mocked(getHistoricalBars).mockRejectedValue(new TradingEngineError('rate limited', 429));
    const app = createApp();
    const res = await request(app)
      .get('/market-data/bars/AAPL?timeframe=1Min&start=2026-08-10T13:30:00Z')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('RATE_LIMITED');
  });
});

describe('GET /market-data/quote/:symbol and /trade/:symbol', () => {
  it('returns latest quote', async () => {
    vi.mocked(getLatestQuote).mockResolvedValue({
      symbol: 'AAPL',
      bid: '191.20000000',
      ask: '191.30000000',
      bid_size: 100,
      ask_size: 200,
      timestamp: '2026-08-10T13:30:01Z',
      is_stale: false,
    });
    const app = createApp();
    const res = await request(app)
      .get('/market-data/quote/AAPL')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.bidSize).toBe(100);
    expect(res.body.bid_size).toBeUndefined();
    expect(res.body.isStale).toBe(false);
  });

  it('returns latest trade', async () => {
    vi.mocked(getLatestTrade).mockResolvedValue({
      symbol: 'AAPL',
      price: '191.25000000',
      size: 50,
      timestamp: '2026-08-10T13:30:02Z',
      exchange: 'V',
      trade_id: 123,
      is_stale: false,
    });
    const app = createApp();
    const res = await request(app)
      .get('/market-data/trade/AAPL')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.tradeId).toBe(123);
    expect(res.body.trade_id).toBeUndefined();
  });

  it('returns 404 for unknown latest quote symbol', async () => {
    vi.mocked(getLatestQuote).mockResolvedValue(null);
    const app = createApp();
    const res = await request(app)
      .get('/market-data/quote/ZZZZZ')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});
