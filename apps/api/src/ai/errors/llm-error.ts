import { AIError } from './ai-error.js';

// Thrown for any failure originating from an LLM call that isn't more
// specifically a ProviderError or RateLimitError — e.g. the provider
// returned a response but it was unusable (empty content, unexpected
// finish reason).
export class LLMError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}
