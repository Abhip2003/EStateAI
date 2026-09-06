export interface RetryOptions {
  retries: number;
  backoffMs: number;
  // Only errors this returns true for are retried; anything else rethrows
  // immediately. Defaults to RateLimitError-only (see errors/).
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff: attempt N waits backoffMs * 2^(N-1) before retrying.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const isRetryable = options.isRetryable ?? (() => false);
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const attemptsRemaining = options.retries + 1 - attempt;
      if (attemptsRemaining <= 0 || !isRetryable(error)) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      await sleep(options.backoffMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
