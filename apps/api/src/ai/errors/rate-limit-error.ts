import { AIError } from './ai-error.js';

// A provider-side rate limit (HTTP 429) or transient overload (5xx). Always
// retryable — withRetry() in utils/retry.ts treats this class as its
// retry signal.
export class RateLimitError extends AIError {
  readonly providerId: string;
  readonly retryAfterMs?: number;

  constructor(providerId: string, message: string, retryAfterMs?: number) {
    super(`[${providerId}] ${message}`);
    this.name = 'RateLimitError';
    this.providerId = providerId;
    this.retryAfterMs = retryAfterMs;
  }
}
