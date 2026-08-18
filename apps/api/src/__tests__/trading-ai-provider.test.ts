import { describe, expect, it } from 'vitest';
import { describeTradingAIProvider, getTradingAIProvider, isAiProviderConfigured } from '../services/trading-ai/provider';
import { AiProviderNotConfiguredError } from '../services/trading-ai/types';
import { AnthropicTradingAIProvider } from '../services/trading-ai/anthropic-provider';
import { OpenAITradingAIProvider } from '../services/trading-ai/openai-provider';

describe('Trading AI provider selection', () => {
  it('throws AI_PROVIDER_NOT_CONFIGURED when no provider env is set', () => {
    expect(() => getTradingAIProvider({})).toThrow(AiProviderNotConfiguredError);
    expect(isAiProviderConfigured({})).toBe(false);
  });

  it('throws AI_PROVIDER_NOT_CONFIGURED for openai without an API key', () => {
    expect(() => getTradingAIProvider({ TRADING_AI_PROVIDER: 'openai', TRADING_AI_MODEL: 'gpt-5.6-terra' })).toThrow(AiProviderNotConfiguredError);
  });

  it('throws AI_PROVIDER_NOT_CONFIGURED for openai without a model', () => {
    expect(() => getTradingAIProvider({ TRADING_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' })).toThrow(AiProviderNotConfiguredError);
  });

  it('returns a configured OpenAITradingAIProvider when fully configured (the default/primary provider)', () => {
    const env = { TRADING_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', TRADING_AI_MODEL: 'gpt-5.6-terra' };
    const provider = getTradingAIProvider(env);
    expect(provider).toBeInstanceOf(OpenAITradingAIProvider);
    expect(provider.providerName).toBe('openai');
    expect(provider.model).toBe('gpt-5.6-terra');
    expect(isAiProviderConfigured(env)).toBe(true);
  });

  it('is case-insensitive and trims TRADING_AI_PROVIDER', () => {
    const provider = getTradingAIProvider({ TRADING_AI_PROVIDER: '  OpenAI  ', OPENAI_API_KEY: 'sk-test', TRADING_AI_MODEL: 'gpt-5.6-terra' });
    expect(provider).toBeInstanceOf(OpenAITradingAIProvider);
  });

  it('throws AI_PROVIDER_NOT_CONFIGURED for anthropic without an API key', () => {
    expect(() => getTradingAIProvider({ TRADING_AI_PROVIDER: 'anthropic', TRADING_AI_MODEL: 'claude-sonnet-5' })).toThrow(AiProviderNotConfiguredError);
  });

  it('throws AI_PROVIDER_NOT_CONFIGURED for anthropic without a model', () => {
    expect(() => getTradingAIProvider({ TRADING_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' })).toThrow(AiProviderNotConfiguredError);
  });

  it('throws for an unrecognized provider name', () => {
    expect(() => getTradingAIProvider({ TRADING_AI_PROVIDER: 'not-a-real-provider' })).toThrow(AiProviderNotConfiguredError);
  });

  it('still supports anthropic as the alternative provider', () => {
    const provider = getTradingAIProvider({ TRADING_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', TRADING_AI_MODEL: 'claude-sonnet-5' });
    expect(provider).toBeInstanceOf(AnthropicTradingAIProvider);
    expect(provider.providerName).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-5');
    expect(isAiProviderConfigured({ TRADING_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', TRADING_AI_MODEL: 'claude-sonnet-5' })).toBe(true);
  });

  describe('describeTradingAIProvider (diagnostics)', () => {
    it('never includes the API key', () => {
      const summary = describeTradingAIProvider({ TRADING_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-super-secret-value', TRADING_AI_MODEL: 'gpt-5.6-terra' });
      expect(JSON.stringify(summary)).not.toContain('sk-super-secret-value');
      expect(summary).toEqual({ provider: 'openai', model: 'gpt-5.6-terra', configured: true });
    });

    it('reports configured=false and still no key when nothing is set', () => {
      expect(describeTradingAIProvider({})).toEqual({ provider: null, model: null, configured: false });
    });

    it('reports the model even when the provider is not fully configured', () => {
      const summary = describeTradingAIProvider({ TRADING_AI_PROVIDER: 'openai', TRADING_AI_MODEL: 'gpt-5.6-terra' });
      expect(summary).toEqual({ provider: 'openai', model: 'gpt-5.6-terra', configured: false });
    });
  });
});
