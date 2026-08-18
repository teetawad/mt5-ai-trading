import { AiProviderNotConfiguredError, TradingAIProvider } from './types';
import { AnthropicTradingAIProvider } from './anthropic-provider';
import { OpenAITradingAIProvider } from './openai-provider';

/**
 * Provider/model are configurable through environment only (spec section 3)
 * — never hardcoded, and no fake/deterministic fallback is ever substituted
 * for a real AI response. When nothing is configured, every caller must
 * surface AI_PROVIDER_NOT_CONFIGURED rather than silently degrading.
 *
 * Architecture:
 *   TradingAIProvider (interface)
 *     +- OpenAITradingAIProvider   (TRADING_AI_PROVIDER=openai — the default/primary provider)
 *     +- AnthropicTradingAIProvider (TRADING_AI_PROVIDER=anthropic — kept as an alternative)
 *
 * Selection is explicit and env-driven only; there is no implicit fallback
 * from one provider to the other.
 */
export function getTradingAIProvider(env: NodeJS.ProcessEnv = process.env): TradingAIProvider {
  const providerName = (env.TRADING_AI_PROVIDER ?? '').trim().toLowerCase();
  const model = env.TRADING_AI_MODEL;

  if (providerName === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey || !model) {
      throw new AiProviderNotConfiguredError(
        'AI PROVIDER NOT CONFIGURED: TRADING_AI_PROVIDER=openai requires OPENAI_API_KEY and TRADING_AI_MODEL to be set.',
      );
    }
    return new OpenAITradingAIProvider(apiKey, model);
  }

  if (providerName === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey || !model) {
      throw new AiProviderNotConfiguredError(
        'AI PROVIDER NOT CONFIGURED: TRADING_AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY and TRADING_AI_MODEL to be set.',
      );
    }
    return new AnthropicTradingAIProvider(apiKey, model);
  }

  throw new AiProviderNotConfiguredError(
    'AI PROVIDER NOT CONFIGURED: set TRADING_AI_PROVIDER (openai or anthropic) plus the matching credentials/model in the environment.',
  );
}

export function isAiProviderConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getTradingAIProvider(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-secret diagnostics summary (spec section 14): provider name and model
 * come straight from env, `configured` reflects whether a real provider
 * instance could be built — the API key itself is NEVER included here or
 * anywhere else in a response body/log.
 */
export function describeTradingAIProvider(env: NodeJS.ProcessEnv = process.env): { provider: string | null; model: string | null; configured: boolean } {
  const providerName = (env.TRADING_AI_PROVIDER ?? '').trim().toLowerCase();
  return {
    provider: providerName || null,
    model: env.TRADING_AI_MODEL ?? null,
    configured: isAiProviderConfigured(env),
  };
}
