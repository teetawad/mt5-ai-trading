import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/tokens';
import { createApp } from '../app';

// Deliberately does NOT mock ../services/mt5-client: when the AI provider is
// unconfigured, analyzeSymbolWithAI must return before ever touching MT5, so
// this test also proves that ordering (no accidental MT5 call first).

// getPool() itself must never be reached for this test's scenario either
// (analyzeSymbolWithAI returns aiConfigured:false before any DB query runs),
// but the route handler still calls getPool() to obtain the argument, so a
// real DATABASE_URL/Postgres must never be required just to prove that.
vi.mock('../db/client', () => ({
  getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })),
}));

describe('AI Trade routes — provider not configured', () => {
  let savedProvider: string | undefined;
  let savedKey: string | undefined;
  let savedModel: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.TRADING_AI_PROVIDER;
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedModel = process.env.TRADING_AI_MODEL;
    delete process.env.TRADING_AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TRADING_AI_MODEL;
  });

  afterEach(() => {
    if (savedProvider !== undefined) process.env.TRADING_AI_PROVIDER = savedProvider; else delete process.env.TRADING_AI_PROVIDER;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey; else delete process.env.ANTHROPIC_API_KEY;
    if (savedModel !== undefined) process.env.TRADING_AI_MODEL = savedModel; else delete process.env.TRADING_AI_MODEL;
  });

  function ownerToken() {
    return signToken({ sub: '00000000-0000-4000-8000-000000000000', email: 'owner@test.local', role: 'owner' } as never);
  }

  it('GET /mt5/ai-trade/status reports configured=false when nothing is set', async () => {
    const app = createApp();
    const token = ownerToken();
    const res = await request(app).get('/mt5/ai-trade/status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it('POST /mt5/ai-trade/:symbol returns AI_PROVIDER_NOT_CONFIGURED, never a fake recommendation', async () => {
    const app = createApp();
    const token = ownerToken();
    const res = await request(app).post('/mt5/ai-trade/EURUSD').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('AI_PROVIDER_NOT_CONFIGURED');
    expect(res.body.decision).toBeUndefined();
  });

  it('rejects unauthenticated requests before ever reaching the AI provider check', async () => {
    const app = createApp();
    const res = await request(app).post('/mt5/ai-trade/EURUSD');
    expect(res.status).toBe(401);
  });
});

// Root cause fix for "MT5 does not recognize symbol SCAN" (spec section 1):
// a scanner pseudo-symbol must never reach a real MT5 call — it must be
// rejected immediately, before assetClassFor() even queries the DB, and long
// before analyzeSymbolWithAI() would otherwise call the AI provider.
describe('AI Trade routes — pseudo-symbols are rejected before any MT5/AI call', () => {
  let savedProvider: string | undefined;
  let savedKey: string | undefined;
  let savedModel: string | undefined;

  beforeEach(() => {
    savedProvider = process.env.TRADING_AI_PROVIDER;
    savedKey = process.env.OPENAI_API_KEY;
    savedModel = process.env.TRADING_AI_MODEL;
    process.env.TRADING_AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    process.env.TRADING_AI_MODEL = 'gpt-5.6-terra';
  });

  afterEach(() => {
    if (savedProvider !== undefined) process.env.TRADING_AI_PROVIDER = savedProvider; else delete process.env.TRADING_AI_PROVIDER;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedModel !== undefined) process.env.TRADING_AI_MODEL = savedModel; else delete process.env.TRADING_AI_MODEL;
  });

  function ownerToken() {
    return signToken({ sub: '00000000-0000-4000-8000-000000000000', email: 'owner@test.local', role: 'owner' } as never);
  }

  // Deliberately excludes 'scan' in any casing: Express's default router is
  // case-insensitive, so POST /mt5/ai-trade/scan AND /mt5/ai-trade/SCAN both
  // now reach the real "FIND BEST TRADES" scanner endpoint (see
  // mt5-scan-route-order.test.ts), not this single-symbol guard — which is
  // the correct fix for the reported bug, not a regression. Only pseudo-
  // symbols that don't literally match any registered route fall through to
  // the assetClassFor() catalog guard tested here.
  it.each(['ALL', 'BEST'])('POST /mt5/ai-trade/%s is rejected as SYMBOL_NOT_IN_CATALOG, never sent to MT5/AI', async (pseudoSymbol) => {
    const app = createApp();
    const token = ownerToken();
    const res = await request(app).post(`/mt5/ai-trade/${pseudoSymbol}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SYMBOL_NOT_IN_CATALOG');
  });

  it('POST /mt5/ai-trade/* (percent-encoded) is also rejected as SYMBOL_NOT_IN_CATALOG', async () => {
    const app = createApp();
    const token = ownerToken();
    const res = await request(app).post('/mt5/ai-trade/%2A').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SYMBOL_NOT_IN_CATALOG');
  });
});
