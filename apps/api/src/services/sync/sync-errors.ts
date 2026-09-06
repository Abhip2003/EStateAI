// Thrown for an unsupported/unregistered provider name — no SyncProvider is
// registered for the account's `provider` value. A structural problem, not
// a failed sync attempt, so SyncService lets this propagate rather than
// folding it into a SyncResult.
export class SyncProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncProviderError';
  }
}

// The stored credential is missing, or the provider rejected it (expired,
// revoked, wrong scope). Captured in SyncResult, not thrown — a failed sync
// attempt with a diagnosable cause.
export class InvalidCredentialError extends Error {
  constructor(message = 'The stored credential was rejected by the provider') {
    super(message);
    this.name = 'InvalidCredentialError';
  }
}

// The provider's API itself is unreachable or returned a server error —
// distinct from InvalidCredentialError, which is specifically an auth
// rejection.
export class ProviderUnavailableError extends Error {
  constructor(message = 'The provider is currently unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

// Catch-all for a provider.sync() failure that isn't a credential or
// availability problem.
export class SyncFailedError extends Error {
  constructor(message = 'Synchronization failed') {
    super(message);
    this.name = 'SyncFailedError';
  }
}
