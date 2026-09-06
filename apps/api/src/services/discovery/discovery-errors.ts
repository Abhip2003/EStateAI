// Thrown for an unsupported/unregistered provider name — a structural
// problem, not a failed discovery attempt, so DiscoveryService lets this
// propagate rather than folding it into a DiscoveryResult.
export class UnsupportedDiscoveryProviderError extends Error {
  constructor(provider: string) {
    super(`No discovery provider registered for "${provider}"`);
    this.name = 'UnsupportedDiscoveryProviderError';
  }
}

// The provider rejected the request outright (bad/expired credential).
// Captured in DiscoveryResult, not thrown — a failed attempt with a
// diagnosable cause.
export class DiscoveryProviderError extends Error {
  constructor(message = 'The provider rejected the discovery request') {
    super(message);
    this.name = 'DiscoveryProviderError';
  }
}

// Catch-all for a discover() failure that isn't a credential rejection
// (provider unreachable, unexpected response, partial failure, ...).
export class DiscoveryFailedError extends Error {
  constructor(message = 'Discovery failed') {
    super(message);
    this.name = 'DiscoveryFailedError';
  }
}
