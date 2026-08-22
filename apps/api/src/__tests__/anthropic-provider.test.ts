import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicTradingAIProvider } from '../services/trading-ai/anthropic-provider';
import { AiProviderBillingError, AiProviderRateLimitError } from '../services/trading-ai/types';
import { MarketAnalysisPackage } from '../services/trading-ai/types';

// Anthropic is not the currently-configured provider (see provider.ts), but
// carries the exact same 429 quota-vs-rate-limit regression risk as
// openai-provider.ts (see AiProviderRateLimitError's own doc comment for the
// incident this fixes) — kept in parity so switching providers can never
// silently reintroduce it.

function pkg(): MarketAnalysisPackage {
  return {
    symbol: 'XAUUSD',
    assetClass: 'METAL',
    generatedAt: new Date().toISOString(),
    quote: { bid: 4398.1, ask: 4398.3, spread: 0.2, digits: 2, point: 0.01, quoteAgeSeconds: 1 },
    market: { status: 'CONNECTED', dataStatus: 'LIVE', sessionOpen: null, sessionClose: null, nextOpen: null },
    timeframes: [],
    account: { balance: 10000, equity: 10000, freeMargin: 9000, currency: 'USD' },
    existingPosition: { exists: false },
    existingPendingOrder: { exists: false },
  };
}

function buyPlanJson(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD', asset_class: 'METAL', decision: 'BUY', confidence_pct: 76, tradeability_pct: 70, profitability_score: 68,
    market_condition: 'trending bullish', trend: 'BULLISH', entry_type: 'MARKET_NOW',
    current_price: 4398.3, entry_price: 4398.3, entry_zone_low: null, entry_zone_high: null, trigger_price: null,
    pending_order_type: 'NONE', stop_loss: 4385, take_profit: 4425, risk_reward: 2,
    lot_size_suggestion: 0.01, expected_holding_minutes: 120, plan_expiry_minutes: 60,
    invalidation_reason: null, reason_summary: 'Bullish continuation', reason_details: ['H1 uptrend'], risks: [],
    ...overrides,
  };
}

function toolUseBody(planJson: unknown) {
  return { content: [{ type: 'tool_use', input: planJson }] };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('AnthropicTradingAIProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a real quota/credit error on a 429 maps to AiProviderBillingError, never retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }));
    const provider = new AnthropicTradingAIProvider('sk-test', 'claude-test');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiProviderBillingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient rate_limit_error 429 and succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }))
      .mockResolvedValueOnce(jsonResponse(200, toolUseBody(buyPlanJson())));
    const provider = new AnthropicTradingAIProvider('sk-test', 'claude-test');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.plan.decision).toBe('BUY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting rate-limit retries and throws AiProviderRateLimitError', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    const provider = new AnthropicTradingAIProvider('sk-test', 'claude-test');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    const assertion = expect(promise).rejects.toThrow(AiProviderRateLimitError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
