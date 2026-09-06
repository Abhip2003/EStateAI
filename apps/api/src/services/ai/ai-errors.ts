export class UnsupportedAIProviderError extends Error {
  constructor(providerId: string) {
    super(`No AI provider registered for "${providerId}"`);
    this.name = 'UnsupportedAIProviderError';
  }
}

export class UnsupportedAIModelError extends Error {
  constructor(model: string) {
    super(`No registered AI provider supports model "${model}"`);
    this.name = 'UnsupportedAIModelError';
  }
}

// The provider rejected the request outright (bad/missing API key,
// malformed request) — not worth retrying, same distinction
// DiscoveryProviderError/PermanentJobError draw elsewhere in this codebase.
export class AIProviderRequestError extends Error {
  constructor(message = 'The AI provider rejected the request') {
    super(message);
    this.name = 'AIProviderRequestError';
  }
}

// The provider is unreachable, timed out, or returned a 5xx — worth
// retrying with backoff.
export class AIProviderTransientError extends Error {
  constructor(message = 'The AI provider request failed transiently') {
    super(message);
    this.name = 'AIProviderTransientError';
  }
}
