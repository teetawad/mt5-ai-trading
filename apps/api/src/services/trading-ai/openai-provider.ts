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

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 45_000;

interface ResponsesApiContentBlock {
  type: string;
  text?: string;
}

interface ResponsesApiOutputItem {
  type: string;
  role?: string;
  content?: ResponsesApiContentBlock[];
}

interface ResponsesApiBody {
  output?: ResponsesApiOutputItem[];
  status?: string;
}

/**
 * Trading AI provider backed by the OpenAI Responses API
 * (https://api.openai.com/v1/responses), using its native structured-output
 * mode (`text.format: { type: "json_schema", strict: true }`) so the model
 * is forced to emit exactly the trade-plan shape — never free-form prose
 * that would need brittle parsing. Calls the API directly over fetch
 * (no SDK dependency) for the same reason as AnthropicTradingAIProvider:
 * one fewer third-party version to track, full control over timeout/error
 * handling, and a consistent pattern across providers.
 *
 * This class only ever produces a TradeAIPlan — it has no knowledge of
 * order_send(), the Risk Engine, or MT5, and cannot execute anything.
 */
export class OpenAITradingAIProvider implements TradingAIProvider {
  readonly providerName = 'openai';

  constructor(private readonly apiKey: string, readonly model: string) {}

  async analyze(input: { pkg: MarketAnalysisPackage; charts: ChartRef[]; promptVersion: string }): Promise<{ raw: unknown; plan: TradeAIPlan; rawConfidence: unknown }> {
    const { system, user } = buildTradingAiPrompt(input.pkg, input.promptVersion);

    const userContent: unknown[] = [{ type: 'input_text', text: user }];
    for (const chart of input.charts) {
      userContent.push({
        type: 'input_image',
        image_url: `data:${chart.mediaType || 'image/png'};base64,${chart.imageBase64}`,
      });
      userContent.push({ type: 'input_text', text: `The image above is the ${chart.timeframe} candlestick chart for ${input.pkg.symbol}.` });
    }

    const body = {
      model: this.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: userContent },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'trade_plan',
          schema: tradePlanJsonSchemaObject(),
          strict: true,
        },
      },
    };

    let response: Response | null = null;
    let rateLimitMessage = '';
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(OPENAI_API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
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

      // 429 covers two very different situations: real quota/billing
      // exhaustion (retrying never helps) vs. a genuinely transient
      // "too many requests right now" rate limit — a burst scan across many
      // shortlisted symbols (e.g. "FIND BEST TRADES") can trip the latter on
      // a fully funded account. Only the latter is ever retried, and only up
      // to RATE_LIMIT_MAX_RETRIES times.
      const bodyText = await response.text().catch(() => '');
      const classification = classifyRateLimitResponseBody(bodyText);
      rateLimitMessage = classification.message;
      if (!classification.retryable) {
        throw new AiProviderBillingError(`OPENAI API BILLING/QUOTA ERROR: ${classification.message}`);
      }
      if (attempt === RATE_LIMIT_MAX_RETRIES) {
        throw new AiProviderRateLimitError(`OPENAI API RATE LIMITED after ${RATE_LIMIT_MAX_RETRIES + 1} attempts: ${rateLimitMessage}`);
      }
      await sleep(rateLimitRetryDelayMs(response, attempt, RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS));
    }
    // The loop above always either `break`s with a 2xx/4xx/5xx response,
    // throws, or exhausts retries (which also throws) — response is always
    // assigned by the time execution reaches here.
    response = response as Response;

    if (response.status === 401) {
      throw new AiProviderAuthError('OPENAI AUTHENTICATION FAILED');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Trading AI provider returned ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as ResponsesApiBody;
    const candidate = extractStructuredOutput(data);
    const rawConfidence = (candidate as Record<string, unknown> | null)?.confidence_pct;
    const plan = parseTradeAIPlan(candidate);
    return { raw: data, plan, rawConfidence };
  }
}

function extractStructuredOutput(data: ResponsesApiBody): unknown {
  const message = data.output?.find((item) => item.type === 'message' && item.role === 'assistant');
  const textBlock = message?.content?.find((block) => block.type === 'output_text');
  const refusal = message?.content?.find((block) => block.type === 'refusal');
  if (refusal) {
    throw new AiResponseInvalidError(`AI_RESPONSE_INVALID: OpenAI refused to produce a structured plan: ${refusal.text ?? 'no reason given'}`);
  }
  if (!textBlock?.text) {
    throw new AiResponseInvalidError('AI_RESPONSE_INVALID: OpenAI response did not include a structured output_text block');
  }
  try {
    return JSON.parse(textBlock.text);
  } catch (err) {
    throw new AiResponseInvalidError(`AI_RESPONSE_INVALID: OpenAI structured output was not valid JSON: ${(err as Error).message}`);
  }
}
