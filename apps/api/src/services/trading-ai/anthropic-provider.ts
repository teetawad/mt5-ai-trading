import { buildTradingAiPrompt } from './prompt';
import { classifyRateLimitResponseBody, rateLimitRetryDelayMs, RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_MAX_RETRIES, sleep } from './provider-http';
import { parseTradeAIPlan } from './schema';
import { tradePlanJsonSchemaObject } from './trade-plan-json-schema';
import {
  AiProviderAuthError,
  AiProviderBillingError,
  AiProviderRateLimitError,
  AiRequestTimeoutError,
  AiResponseInvalidError,
  ChartRef,
  MarketAnalysisPackage,
  TradeAIPlan,
  TradingAIProvider,
} from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 45_000;

// Forces the model to emit exactly this structure (via tool_choice) instead
// of free-form prose that would need brittle text parsing.
const TRADE_PLAN_TOOL_SCHEMA = {
  name: 'submit_trade_plan',
  description: 'Submit the completed structured trade plan for this symbol.',
  input_schema: tradePlanJsonSchemaObject(),
};

export class AnthropicTradingAIProvider implements TradingAIProvider {
  readonly providerName = 'anthropic';

  constructor(private readonly apiKey: string, readonly model: string) {}

  async analyze(input: { pkg: MarketAnalysisPackage; charts: ChartRef[]; promptVersion: string }): Promise<{ raw: unknown; plan: TradeAIPlan; rawConfidence: unknown }> {
    const { system, user } = buildTradingAiPrompt(input.pkg, input.promptVersion);

    const content: unknown[] = [{ type: 'text', text: user }];
    for (const chart of input.charts) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: chart.mediaType || 'image/png', data: chart.imageBase64 },
      });
      content.push({ type: 'text', text: `The image above is the ${chart.timeframe} candlestick chart for ${input.pkg.symbol}.` });
    }

    const body = {
      model: this.model,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content }],
      tools: [TRADE_PLAN_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'submit_trade_plan' },
    };

    let response: Response | null = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw new AiRequestTimeoutError();
        throw new Error(`Trading AI provider request failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }

      if (response.status !== 429) break;

      // Same distinction as OpenAI (see provider-http.ts): a genuinely
      // transient rate limit is retried with backoff; real quota/credit
      // exhaustion is not.
      const bodyText = await response.text().catch(() => '');
      const classification = classifyRateLimitResponseBody(bodyText);
      if (!classification.retryable) {
        throw new AiProviderBillingError(`ANTHROPIC API BILLING/QUOTA ERROR: ${classification.message}`);
      }
      if (attempt === RATE_LIMIT_MAX_RETRIES) {
        throw new AiProviderRateLimitError(`ANTHROPIC API RATE LIMITED after ${RATE_LIMIT_MAX_RETRIES + 1} attempts: ${classification.message}`);
      }
      await sleep(rateLimitRetryDelayMs(response, attempt, RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS));
    }
    response = response as Response;

    if (response.status === 401 || response.status === 403) {
      throw new AiProviderAuthError('ANTHROPIC AUTHENTICATION FAILED');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Trading AI provider returned ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as { content?: Array<{ type: string; input?: unknown }> };
    const toolUse = data.content?.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      throw new AiResponseInvalidError('AI_RESPONSE_INVALID: Anthropic response did not include the requested tool_use block');
    }

    const rawConfidence = (toolUse.input as Record<string, unknown> | null)?.confidence_pct;
    const plan = parseTradeAIPlan(toolUse.input);
    return { raw: data, plan, rawConfidence };
  }
}
