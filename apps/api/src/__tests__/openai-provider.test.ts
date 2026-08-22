import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAITradingAIProvider } from '../services/trading-ai/openai-provider';
import { AiProviderAuthError, AiProviderBillingError, AiProviderRateLimitError, AiRequestTimeoutError, AiResponseInvalidError } from '../services/trading-ai/types';
import { AiPlanValidationError } from '../services/trading-ai/types';
import { MarketAnalysisPackage } from '../services/trading-ai/types';

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

function sellPlanJson(overrides: Record<string, unknown> = {}) {
  return { ...buyPlanJson(), decision: 'SELL', current_price: 4398.1, entry_price: 4398.1, stop_loss: 4412, take_profit: 4370, ...overrides };
}

function waitPlanJson(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'XAUUSD', asset_class: 'METAL', decision: 'WAIT', confidence_pct: 55, tradeability_pct: 0, profitability_score: 0,
    market_condition: 'choppy range', trend: 'RANGE', entry_type: 'NO_ENTRY',
    current_price: null, entry_price: null, entry_zone_low: null, entry_zone_high: null, trigger_price: null,
    pending_order_type: 'NONE', stop_loss: null, take_profit: null, risk_reward: null,
    lot_size_suggestion: null, expected_holding_minutes: null, plan_expiry_minutes: 30,
    invalidation_reason: null, reason_summary: 'No clear setup', reason_details: [], risks: [],
    ...overrides,
  };
}

function responsesApiBody(planJson: unknown) {
  return {
    id: 'resp_test',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(planJson) }],
      },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OpenAITradingAIProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('calls the OpenAI Responses API with a forced json_schema structured output', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson())));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.6-terra');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.required).toContain('decision');
  });

  it('never includes the API key in the request body (only the Authorization header)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson())));
    const provider = new OpenAITradingAIProvider('sk-super-secret', 'gpt-5.6-terra');
    await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toContain('sk-super-secret');
  });

  it('sends chart images as multimodal input_image blocks', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson())));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await provider.analyze({
      pkg: pkg(),
      charts: [{ timeframe: 'H1', mediaType: 'image/png', imageBase64: 'ZmFrZS1wbmc=' }],
      promptVersion: 'TEST',
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    const userContent = body.input[1].content;
    const image = userContent.find((block: { type: string }) => block.type === 'input_image');
    expect(image.image_url).toBe('data:image/png;base64,ZmFrZS1wbmc=');
  });

  it('parses a BUY structured response into a valid TradeAIPlan with its own confidence_pct', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson({ confidence_pct: 76 }))));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.decision).toBe('BUY');
    expect(plan.confidence_pct).toBe(76);
  });

  it('parses a SELL structured response into a valid TradeAIPlan with its own (different) confidence_pct', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(sellPlanJson({ confidence_pct: 62 }))));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.decision).toBe('SELL');
    expect(plan.confidence_pct).toBe(62);
  });

  it('parses a WAIT structured response into a valid TradeAIPlan, preserving a high confidence_pct (WAIT is not forced to 0)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(waitPlanJson({ confidence_pct: 88 }))));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.decision).toBe('WAIT');
    expect(plan.confidence_pct).toBe(88);
  });

  it('different mocked confidence_pct values for BUY/SELL/WAIT all come through distinctly, never collapsing to the same number', async () => {
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, responsesApiBody(buyPlanJson({ confidence_pct: 91 }))));
    const buyResult = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, responsesApiBody(sellPlanJson({ confidence_pct: 34 }))));
    const sellResult = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, responsesApiBody(waitPlanJson({ confidence_pct: 65 }))));
    const waitResult = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });

    expect(buyResult.plan.confidence_pct).toBe(91);
    expect(sellResult.plan.confidence_pct).toBe(34);
    expect(waitResult.plan.confidence_pct).toBe(65);
  });

  it('regression: a fractional 0-1 confidence from the model (the exact reported bug) is normalized to a whole percent, not left as-is', async () => {
    // This is the literal shape the bug report showed up as in production:
    // the model returned e.g. 0.74 despite the schema asking for 0-100.
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson({ confidence_pct: 0.74 }))));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan, rawConfidence } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(rawConfidence).toBe(0.74); // the raw diagnostic value is preserved unmodified...
    expect(plan.confidence_pct).toBe(74); // ...but the canonical plan value is always normalized.
  });

  it('keeps confidence and Trade Score conceptually separate: the provider never returns a trade_score field at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(buyPlanJson({ confidence_pct: 76 }))));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.confidence_pct).toBe(76);
    expect((plan as unknown as Record<string, unknown>).trade_score).toBeUndefined();
  });

  it('a "wait for pullback to support" narrative paired with a correct structured PULLBACK/BUY_LIMIT plan parses successfully', async () => {
    const pullbackPlan = buyPlanJson({
      entry_type: 'PULLBACK', pending_order_type: 'BUY_LIMIT',
      current_price: 4398.3, entry_price: null, entry_zone_low: 4380, entry_zone_high: 4390, trigger_price: null,
      stop_loss: 4365, take_profit: 4425, risk_reward: 2,
      reason_summary: 'Main trend remains bullish but wait for a pullback to support before entering.',
    });
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(pullbackPlan)));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.entry_type).toBe('PULLBACK');
    expect(plan.pending_order_type).toBe('BUY_LIMIT');
    expect(plan.entry_zone_low).toBe(4380);
    expect(plan.entry_zone_high).toBe(4390);
  });

  it('a "wait for breakout above resistance" narrative paired with a correct structured BREAKOUT/BUY_STOP plan parses successfully', async () => {
    const breakoutPlan = buyPlanJson({
      entry_type: 'BREAKOUT', pending_order_type: 'BUY_STOP',
      current_price: 4398.3, entry_price: null, entry_zone_low: null, entry_zone_high: null, trigger_price: 4410,
      stop_loss: 4390, take_profit: 4440, risk_reward: 2,
      reason_summary: 'Wait for confirmation above resistance before entering the breakout.',
    });
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(breakoutPlan)));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const { plan } = await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    expect(plan.entry_type).toBe('BREAKOUT');
    expect(plan.pending_order_type).toBe('BUY_STOP');
    expect(plan.trigger_price).toBe(4410);
  });

  it('rejects a malformed response with no structured output block as AI_RESPONSE_INVALID', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'resp_test', status: 'completed', output: [] }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiResponseInvalidError);
  });

  it('rejects unparsable JSON in the structured output as AI_RESPONSE_INVALID', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      id: 'resp_test', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{not valid json' }] }],
    }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiResponseInvalidError);
  });

  it('rejects a well-formed JSON object that fails strict schema validation with AiPlanValidationError, not AI_RESPONSE_INVALID', async () => {
    const invalidPlan = { ...buyPlanJson(), stop_loss: null }; // BUY requires stop_loss
    fetchMock.mockResolvedValue(jsonResponse(200, responsesApiBody(invalidPlan)));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiPlanValidationError);
  });

  it('surfaces an explicit refusal as AI_RESPONSE_INVALID rather than creating a plan', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      id: 'resp_test', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', text: 'cannot comply' }] }],
    }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiResponseInvalidError);
  });

  it('maps a 401 response to OPENAI AUTHENTICATION FAILED', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'Incorrect API key provided' } }));
    const provider = new OpenAITradingAIProvider('sk-bad', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiProviderAuthError);
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow('OPENAI AUTHENTICATION FAILED');
  });

  it('maps a 429 with an insufficient_quota error type to OPENAI API BILLING/QUOTA ERROR, never retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiProviderBillingError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // real quota exhaustion — retrying would never help
  });

  it('maps a 429 with no recognizable error type to OPENAI API BILLING/QUOTA ERROR (safer default: never spin-retry an unrecognized 429 shape)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'Too many requests' } }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(AiProviderBillingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression test (owner report: "FIND BEST TRADES" scan across 20
  // shortlisted symbols came back with Valid trade plans: 0, all 20 showing
  // "Technical blocked" — the real ai_analysis_runs rows all recorded
  // provider_error='OPENAI API BILLING/QUOTA ERROR' for a 429 response, even
  // though the account was not actually out of quota; it was rate-limited by
  // the burst of concurrent requests. A rate_limit_exceeded 429 must be
  // retried, not immediately treated as billing exhaustion.
  it('retries a transient rate_limit_exceeded 429 with backoff and succeeds once the provider stops rate-limiting', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }))
      .mockResolvedValueOnce(jsonResponse(200, responsesApiBody(buyPlanJson())));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.plan.decision).toBe('BUY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting rate-limit retries and throws AiProviderRateLimitError, distinct from billing exhaustion', async () => {
    vi.useFakeTimers();
    // A fresh Response per call (mockImplementation), not a single shared
    // instance (mockResolvedValue) — a real fetch() response body can only
    // ever be read once, and this test's code reads the body on every retry
    // attempt to classify the 429.
    fetchMock.mockImplementation(async () => jsonResponse(429, { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    const assertion = expect(promise).rejects.toThrow(AiProviderRateLimitError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it('respects a Retry-After header on a retryable 429 instead of the default backoff delay', async () => {
    vi.useFakeTimers();
    const rateLimited = new Response(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    });
    fetchMock.mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(jsonResponse(200, responsesApiBody(buyPlanJson())));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;
    expect(result.plan.decision).toBe('BUY');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never leaks the API key into a thrown error message on auth failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'unauthorized' } }));
    const provider = new OpenAITradingAIProvider('sk-super-secret-leak-check', 'gpt-5.6-terra');
    try {
      await provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
      throw new Error('expected analyze() to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-super-secret-leak-check');
    }
  });

  it('maps an aborted/timed-out request to AI_REQUEST_TIMEOUT', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    const promise = provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' });
    const assertion = expect(promise).rejects.toThrow(AiRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;
  });

  it('surfaces a generic error for other non-ok statuses without exposing internals', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'internal server error' } }));
    const provider = new OpenAITradingAIProvider('sk-test', 'gpt-5.6-terra');
    await expect(provider.analyze({ pkg: pkg(), charts: [], promptVersion: 'TEST' })).rejects.toThrow(/500/);
  });
});
