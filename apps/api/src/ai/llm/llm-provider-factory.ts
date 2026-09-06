import type { LLMProvider } from '../interfaces/llm-provider.interface.js';
import type { AIFoundationConfig } from '../config/ai-config.js';
import type { LLMProviderId } from '../types/common.js';
import { ProviderError } from '../errors/index.js';
import { OpenAIProvider } from './providers/openai.provider.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { OllamaProvider } from './providers/ollama.provider.js';
import { AzureOpenAIProvider } from './providers/azure-openai.provider.js';

// Constructor-injected config (no module-level singleton config read)
// keeps this factory trivially testable — pass a fake AIFoundationConfig
// to get providers pointed at a mock server, no env manipulation needed.
export class LLMProviderFactory {
  constructor(private readonly aiConfig: AIFoundationConfig) {}

  create(providerId: LLMProviderId): LLMProvider {
    const providerConfig = this.aiConfig.providers[providerId];
    switch (providerId) {
      case 'openai':
        return new OpenAIProvider(providerConfig);
      case 'anthropic':
        return new AnthropicProvider();
      case 'gemini':
        return new GeminiProvider();
      case 'ollama':
        return new OllamaProvider();
      case 'azure-openai':
        return new AzureOpenAIProvider();
      default: {
        // Unreachable while LLMProviderId stays exhaustively handled above;
        // guards a runtime value that bypassed the type system (e.g. from
        // an external caller not using TypeScript).
        const unknownId = providerId as string;
        throw new ProviderError(unknownId, `unknown provider id "${unknownId}"`);
      }
    }
  }

  createDefault(): LLMProvider {
    return this.create(this.aiConfig.defaultProvider);
  }
}
