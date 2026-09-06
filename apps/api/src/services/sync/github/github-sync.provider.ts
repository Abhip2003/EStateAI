import { config } from '../../../config/env.js';
import {
  InvalidCredentialError,
  ProviderUnavailableError,
  SyncFailedError,
} from '../sync-errors.js';
import type { SyncProvider, SyncProviderResult } from '../sync-provider.interface.js';
import { logger } from '../../../observability/logger.js';

interface GitHubSyncUserResponse {
  login: string;
  public_repos: number;
  followers: number;
}

// A direct, self-contained call to GitHub's /user endpoint rather than
// reusing OAuthProvider.fetchUserProfile: sync needs to tell "bad
// credential" (401/403) apart from "GitHub is down" (5xx), which
// OAuthProvider's interface deliberately doesn't expose — it only ever
// throws one error for any non-OK response. Only the base URL (config) is
// shared with the OAuth module, not its error handling.
function authHeaders(credential: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'EstateAI',
  };
}

class GitHubSyncProvider implements SyncProvider {
  readonly name = 'github';

  async validateCredential(credential: string): Promise<boolean> {
    const res = await fetch(config.oauth.github.userUrl, { headers: authHeaders(credential) });
    return res.ok;
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Unauthenticated request to the same host — a cheap reachability
      // probe that doesn't depend on any one account's credential.
      const res = await fetch(config.oauth.github.userUrl, {
        headers: { Accept: 'application/json' },
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  // Mock discovery statistics only — real repository/org crawling is a
  // later checkpoint. This just proves the credential works end-to-end and
  // returns a standardized result shape.
  async sync(credential: string): Promise<SyncProviderResult> {
    const url = config.oauth.github.userUrl;
    logger.info({ provider: 'github', url, method: 'GET' }, 'github_sync.request');

    let res: Response;
    try {
      res = await fetch(url, { headers: authHeaders(credential) });
    } catch (err) {
      logger.error(
        {
          provider: 'github',
          url,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'github_sync.request_failed',
      );
      throw new ProviderUnavailableError('Could not reach the GitHub API');
    }

    logger.info(
      { provider: 'github', url, status: res.status, statusText: res.statusText },
      'github_sync.response',
    );

    if (!res.ok) {
      const responseBody = await res.text().catch(() => '<unreadable response body>');
      logger.error(
        { provider: 'github', url, status: res.status, responseBody },
        'github_sync.response_error',
      );
      if (res.status === 401 || res.status === 403) {
        throw new InvalidCredentialError('GitHub rejected the stored credential');
      }
      if (res.status >= 500) {
        throw new ProviderUnavailableError(`GitHub API returned ${res.status}`);
      }
      throw new SyncFailedError(`GitHub API returned unexpected status ${res.status}`);
    }

    const body = (await res.json()) as GitHubSyncUserResponse;
    return {
      resourcesDiscovered: body.public_repos,
      details: { login: body.login, publicRepos: body.public_repos, followers: body.followers },
    };
  }

  // No-op — GitHub OAuth App tokens have no server-side revoke call used
  // here (AccountService.disconnect already clears the stored credential
  // locally). Extension point for providers with a real revoke API.
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

export const githubSyncProvider = new GitHubSyncProvider();
