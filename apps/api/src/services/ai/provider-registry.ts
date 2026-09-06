import type { AIProvider } from './provider.interface.js';
import { UnsupportedAIProviderError, UnsupportedAIModelError } from './ai-errors.js';

// Registry pattern, matching agentRegistry/policyRegistry/ruleRegistry —
// AIService never branches on which vendor a provider wraps, it only
// calls resolve()/resolveForModel() against whatever is registered.
class AIProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id(), provider);
  }

  resolve(providerId: string): AIProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new UnsupportedAIProviderError(providerId);
    }
    return provider;
  }

  resolveForModel(model: string): AIProvider {
    const provider = [...this.providers.values()].find((p) => p.supports(model));
    if (!provider) {
      throw new UnsupportedAIModelError(model);
    }
    return provider;
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }
}

export const aiProviderRegistry = new AIProviderRegistry();
