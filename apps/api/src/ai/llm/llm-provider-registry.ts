import type { LLMProvider } from '../interfaces/llm-provider.interface.js';
import type { LLMProviderId } from '../types/common.js';
import { ProviderError } from '../errors/index.js';
import type { LLMProviderFactory } from './llm-provider-factory.js';
import type { AIFoundationConfig } from '../config/ai-config.js';

const ALL_PROVIDER_IDS: LLMProviderId[] = [
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'azure-openai',
];

// Lazily instantiates and caches one LLMProvider per id via the injected
// factory, so callers resolve providers by id without knowing which
// concrete class backs them.
export class LLMProviderRegistry {
  private readonly cache = new Map<LLMProviderId, LLMProvider>();

  constructor(
    private readonly factory: LLMProviderFactory,
    private readonly aiConfig: AIFoundationConfig,
  ) {}

  resolve(providerId: LLMProviderId): LLMProvider {
    const cached = this.cache.get(providerId);
    if (cached) return cached;

    const provider = this.factory.create(providerId);
    this.cache.set(providerId, provider);
    return provider;
  }

  resolveForModel(model: string): LLMProvider {
    for (const providerId of ALL_PROVIDER_IDS) {
      const provider = this.resolve(providerId);
      if (provider.supportsModel(model)) return provider;
    }
    throw new ProviderError('unknown', `no registered provider supports model "${model}"`);
  }

  resolveDefault(): LLMProvider {
    return this.resolve(this.aiConfig.defaultProvider);
  }

  list(): LLMProvider[] {
    return ALL_PROVIDER_IDS.map((id) => this.resolve(id));
  }
}
