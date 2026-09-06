import { config } from '../../../config/env.js';
import { OAuthCodeExchangeError } from '../oauth-errors.js';
import type {
  OAuthProvider,
  OAuthTokenResult,
  OAuthUserProfile,
} from '../oauth-provider.interface.js';
import type { GitHubTokenResponse, GitHubUserResponse } from './github.types.js';

class GitHubProvider implements OAuthProvider {
  readonly name = 'github';

  buildAuthorizationUrl(state: string): string {
    const url = new URL(config.oauth.github.authorizeUrl);
    url.searchParams.set('client_id', config.oauth.github.clientId);
    url.searchParams.set('redirect_uri', config.oauth.github.callbackUrl);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<OAuthTokenResult> {
    const res = await fetch(config.oauth.github.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.oauth.github.clientId,
        client_secret: config.oauth.github.clientSecret,
        code,
        redirect_uri: config.oauth.github.callbackUrl,
      }),
    });

    if (!res.ok) {
      throw new OAuthCodeExchangeError('GitHub token exchange request failed');
    }

    const body = (await res.json()) as GitHubTokenResponse;
    if (body.error || !body.access_token) {
      throw new OAuthCodeExchangeError(
        body.error_description ?? 'GitHub rejected the authorization code',
      );
    }

    return { accessToken: body.access_token, tokenType: body.token_type, scope: body.scope };
  }

  async fetchUserProfile(accessToken: string): Promise<OAuthUserProfile> {
    const res = await fetch(config.oauth.github.userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'EstateAI',
      },
    });

    if (!res.ok) {
      throw new OAuthCodeExchangeError('Failed to fetch the GitHub user profile');
    }

    const body = (await res.json()) as GitHubUserResponse;
    return {
      externalId: String(body.id),
      displayName: body.name ?? body.login,
      email: body.email ?? undefined,
      username: body.login,
      metadata: { avatarUrl: body.avatar_url },
    };
  }

  // Stub — GitHub OAuth App tokens don't expire, so there's nothing to
  // refresh today. Extension point only; see oauth-provider.interface.ts.
  refreshAccessToken(): Promise<OAuthTokenResult> {
    return Promise.reject(
      new OAuthCodeExchangeError('refreshAccessToken is not implemented for github'),
    );
  }

  // Stub — see refreshAccessToken.
  revokeToken(): Promise<void> {
    return Promise.reject(new OAuthCodeExchangeError('revokeToken is not implemented for github'));
  }
}

export const githubProvider = new GitHubProvider();
