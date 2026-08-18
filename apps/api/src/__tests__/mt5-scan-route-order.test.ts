import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/tokens';
import { createApp } from '../app';

// Root-cause regression test for the "FIND BEST TRADES" bug reported as
// `'SCAN is not a real MT5 instrument'`: POST /mt5/ai-trade/scan was being
// silently intercepted by the single-symbol POST /mt5/ai-trade/:symbol
// route (registered before it in mt5.ts), since Express matches routes in
// registration order and `:symbol` matches ANY single path segment,
// including literally "scan". analyzeSymbolWithAI's own pseudo-symbol guard
// (assetClassFor -> AiUnknownSymbolError) was working correctly the whole
// time — it just never should have been reached by a scan click in the
// first place. This test proves the fix by asserting which SERVICE gets
// called for POST /mt5/ai-trade/scan, not just which HTTP status comes
// back (a route-ordering bug and a correctly-routed handler that happens
// to fail can produce similar-looking error responses, so status/body
// alone would not catch a regression here).

vi.mock('../db/client', () => ({
  getPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })),
}));

vi.mock('../services/trading-ai/trading-ai-service', () => ({
  analyzeSymbolWithAI: vi.fn(async () => ({ aiConfigured: false, message: 'not used in this test' })),
  approveAndPlaceAiTradePlan: vi.fn(),
  cancelAiTradePlanOrder: vi.fn(),
  PROMPT_VERSION: 'TRADING_AI_V3_PROMPT_001',
}));

vi.mock('../services/trading-ai/opportunity-scan', () => ({
  runOpportunityScan: vi.fn(async () => ({
    scanId: 'test-scan-id',
    summary: {
      symbolsDiscovered: 0, dataValid: 0, aiShortlisted: 0, actionable: 0, enterNow: 0, waitForEntry: 0,
      technicalBlocked: 0, riskPass: 0, riskBlocked: 0, openAiRequestsUsed: 0, reusedFromCache: 0, topOpportunitiesShown: 0,
    },
    topOpportunities: [],
    actionable: [],
    rejected: [],
    dataRejected: [],
  })),
  listScanCandidates: vi.fn(async () => []),
  getTopOpportunities: vi.fn(async () => []),
}));

describe('POST /mt5/ai-trade/scan route ordering', () => {
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (savedProvider !== undefined) process.env.TRADING_AI_PROVIDER = savedProvider; else delete process.env.TRADING_AI_PROVIDER;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedModel !== undefined) process.env.TRADING_AI_MODEL = savedModel; else delete process.env.TRADING_AI_MODEL;
  });

  function ownerToken() {
    return signToken({ sub: '00000000-0000-4000-8000-000000000000', email: 'owner@test.local', role: 'owner' } as never);
  }

  it('reaches runOpportunityScan, never analyzeSymbolWithAI(symbol="SCAN")', async () => {
    const { runOpportunityScan } = await import('../services/trading-ai/opportunity-scan');
    const { analyzeSymbolWithAI } = await import('../services/trading-ai/trading-ai-service');
    const app = createApp();
    const token = ownerToken();

    const res = await request(app).post('/mt5/ai-trade/scan').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(runOpportunityScan).toHaveBeenCalledTimes(1);
    expect(analyzeSymbolWithAI).not.toHaveBeenCalled();
    // Never called with the pseudo-symbol under any casing, from this route.
    expect(analyzeSymbolWithAI).not.toHaveBeenCalledWith(expect.anything(), 'SCAN', expect.anything());
  });

  it('a genuine single-symbol analyze call still reaches analyzeSymbolWithAI, never runOpportunityScan', async () => {
    const { runOpportunityScan } = await import('../services/trading-ai/opportunity-scan');
    const { analyzeSymbolWithAI } = await import('../services/trading-ai/trading-ai-service');
    const app = createApp();
    const token = ownerToken();

    await request(app).post('/mt5/ai-trade/EURUSD').set('Authorization', `Bearer ${token}`);

    expect(analyzeSymbolWithAI).toHaveBeenCalledTimes(1);
    expect(analyzeSymbolWithAI).toHaveBeenCalledWith(expect.anything(), 'EURUSD', expect.anything());
    expect(runOpportunityScan).not.toHaveBeenCalled();
  });
});
