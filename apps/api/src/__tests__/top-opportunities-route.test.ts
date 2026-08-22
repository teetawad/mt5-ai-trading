import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/tokens';
import { createApp } from '../app';

// Regression coverage for GET /mt5/ai-trade/top-opportunities returning a
// generic 503 "MT5_BACKEND_ERROR" for what was actually a Postgres query
// bug in getTopOpportunities (see opportunity-scan.ts's own doc comment) —
// this endpoint never touches MT5 at all, so that label was actively
// misleading. Asserts both the happy path and that an upstream failure now
// degrades gracefully with a precise, stable code the Home page can use
// (spec: "AI opportunities are temporarily unavailable").

vi.mock('../db/client', () => ({
  getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })),
}));

vi.mock('../services/trading-ai/opportunity-scan', () => ({
  getTopOpportunities: vi.fn(),
  listScanCandidates: vi.fn(async () => []),
  runOpportunityScan: vi.fn(),
}));

describe('GET /mt5/ai-trade/top-opportunities', () => {
  let savedSecret: string | undefined;

  beforeAll(() => {
    savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-integration-secret';
  });

  afterAll(() => {
    if (savedSecret !== undefined) process.env.SESSION_SECRET = savedSecret; else delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function ownerToken() {
    return signToken({ sub: '00000000-0000-4000-8000-000000000000', email: 'owner@test.local', role: 'owner' } as never);
  }

  it('returns 200 with the opportunities array on success', async () => {
    const { getTopOpportunities } = await import('../services/trading-ai/opportunity-scan');
    vi.mocked(getTopOpportunities).mockResolvedValue([{ symbol: 'EURUSD' } as never]);
    const app = createApp();

    const res = await request(app).get('/mt5/ai-trade/top-opportunities').set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.opportunities).toHaveLength(1);
    expect(res.body.opportunities[0].symbol).toBe('EURUSD');
  });

  it('returns a precise, structured 503 (never the generic MT5_BACKEND_ERROR) when the upstream query fails', async () => {
    const { getTopOpportunities } = await import('../services/trading-ai/opportunity-scan');
    vi.mocked(getTopOpportunities).mockRejectedValue(new Error('could not determine data type of parameter $1'));
    const app = createApp();

    const res = await request(app).get('/mt5/ai-trade/top-opportunities').set('Authorization', `Bearer ${ownerToken()}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TOP_OPPORTUNITIES_UNAVAILABLE');
    expect(res.body.error).not.toBe('MT5_BACKEND_ERROR');
    expect(res.body.message).toBe('AI opportunities are temporarily unavailable.');
    // Always a well-formed array, even on failure, so a client reading
    // `.opportunities` directly never has to null-check.
    expect(res.body.opportunities).toEqual([]);
  });
});
