export class InvalidOAuthStateError extends Error {
  constructor(message = 'Invalid or expired OAuth state') {
    super(message);
    this.name = 'InvalidOAuthStateError';
  }
}

// Covers the whole provider handshake failing after a state is validated —
// the provider rejecting the code, or refusing to hand back a usable
// profile once exchanged.
export class OAuthCodeExchangeError extends Error {
  constructor(message = 'Failed to complete the OAuth provider handshake') {
    super(message);
    this.name = 'OAuthCodeExchangeError';
  }
}

// Thrown for an unsupported/unregistered provider name (e.g. `/oauth/foo`
// where "foo" was never registered) — a client input problem, not a
// specific provider's API failing (see OAuthCodeExchangeError for that).
export class OAuthProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}

// Reserved for providers with optional (not-required-at-boot) configuration
// that turns out to be missing when actually used. GitHub's config is
// required at startup (see config/env.ts) and fails fast there, so this is
// never thrown by the current provider — it exists as the extension point
// for future providers that aren't mandatory for every deployment.
export class OAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigurationError';
  }
}

export class DuplicateOAuthConnectionError extends Error {
  constructor(provider: string, externalId: string) {
    super(
      `An account for provider "${provider}" with external id "${externalId}" is already connected`,
    );
    this.name = 'DuplicateOAuthConnectionError';
  }
}
