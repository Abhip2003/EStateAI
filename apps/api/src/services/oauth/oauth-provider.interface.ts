export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresInSeconds?: number;
}

export interface OAuthUserProfile {
  externalId: string;
  displayName?: string;
  email?: string;
  username?: string;
  metadata?: Record<string, unknown>;
}

// Every provider (GitHub today; Google/AWS/Stripe/... later) implements
// this and nothing else — OAuthService and the routes only ever talk to
// this interface, never to a concrete provider class.
export interface OAuthProvider {
  readonly name: string;

  buildAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<OAuthTokenResult>;
  fetchUserProfile(accessToken: string): Promise<OAuthUserProfile>;

  // Extension points only — no provider needs these yet (GitHub OAuth App
  // tokens don't expire and have no revoke endpoint used here), so
  // implementations should reject until a real provider needs them.
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult>;
  revokeToken(token: string): Promise<void>;
}
