import { AIError } from './ai-error.js';

// A provider rejected the request outright (bad request, auth failure,
// unsupported model) or is unreachable. Not retried by default — see
// RateLimitError for the retryable transient case.
export class ProviderError extends AIError {
  readonly providerId: string;
  readonly retryable: boolean;

  constructor(providerId: string, message: string, retryable = false) {
    super(`[${providerId}] ${message}`);
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.retryable = retryable;
  }
}
