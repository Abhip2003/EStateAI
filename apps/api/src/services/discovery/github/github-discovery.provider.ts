import { config } from '../../../config/env.js';
import { DiscoveryFailedError, DiscoveryProviderError } from '../discovery-errors.js';
import type { DiscoveredResource } from '../dto/discovered-resource.js';
import type { DiscoveryProvider } from '../discovery-provider.interface.js';

// Self-contained, like GitHubSyncProvider — not shared with the OAuth or
// Sync github providers, so each provider tree stays independent.
function authHeaders(credential: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'EstateAI',
  };
}

interface GitHubUserApiResponse {
  id: number;
  login: string;
  name: string | null;
  html_url: string;
  public_repos: number;
  followers: number;
}

interface GitHubRepoApiResponse {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  default_branch: string;
  // archived/topics/size added for Phase 6A's rule engine (archived-repo,
  // no-topics, and empty-repo — size in KB is GitHub's own "no commits
  // pushed" signal — detection).
  archived: boolean;
  topics: string[];
  size: number;
  // fork added for Phase 6B's FORK_REPOSITORIES_IGNORED policy.
  fork: boolean;
}

interface GitHubOrgApiResponse {
  id: number;
  login: string;
  description: string | null;
}

class GitHubDiscoveryProvider implements DiscoveryProvider {
  readonly name = 'github';

  // GitHub's REST API supports conditional requests (ETag) and paginated
  // `since` cursors, but discover() always does a full scan for now.
  supportsIncrementalSync(): boolean {
    return false;
  }

  async validate(credential: string): Promise<boolean> {
    const res = await fetch(config.oauth.github.userUrl, { headers: authHeaders(credential) });
    return res.ok;
  }

  // Fetches the authenticated user, their repositories, and their
  // organizations, and normalizes every one into DiscoveredResource. The
  // raw GitHub response shapes (GitHubUserApiResponse etc.) never leave
  // this file.
  async discover(credential: string): Promise<DiscoveredResource[]> {
    const [user, repos, orgs] = await Promise.all([
      this.fetchJson<GitHubUserApiResponse>(config.oauth.github.userUrl, credential),
      this.fetchJson<GitHubRepoApiResponse[]>(config.oauth.github.reposUrl, credential),
      this.fetchJson<GitHubOrgApiResponse[]>(config.oauth.github.orgsUrl, credential),
    ]);

    const discoveredAt = new Date();
    const resources: DiscoveredResource[] = [];

    resources.push({
      provider: this.name,
      providerResourceId: String(user.id),
      resourceType: 'user',
      displayName: user.name ?? user.login,
      externalUrl: user.html_url,
      metadata: {
        login: user.login,
        publicRepos: user.public_repos,
        followers: user.followers,
      },
      discoveredAt,
    });

    for (const repo of repos) {
      resources.push({
        provider: this.name,
        providerResourceId: String(repo.id),
        resourceType: 'repository',
        displayName: repo.full_name,
        description: repo.description ?? undefined,
        externalUrl: repo.html_url,
        metadata: {
          private: repo.private,
          language: repo.language,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          defaultBranch: repo.default_branch,
          archived: repo.archived,
          topics: repo.topics,
          size: repo.size,
          fork: repo.fork,
        },
        discoveredAt,
      });
    }

    for (const org of orgs) {
      resources.push({
        provider: this.name,
        providerResourceId: String(org.id),
        resourceType: 'organization',
        displayName: org.login,
        description: org.description ?? undefined,
        externalUrl: `https://github.com/${org.login}`,
        metadata: {},
        discoveredAt,
      });
    }

    return resources;
  }

  private async fetchJson<T>(url: string, credential: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { headers: authHeaders(credential) });
    } catch {
      throw new DiscoveryFailedError(`Could not reach ${url}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new DiscoveryProviderError('GitHub rejected the stored credential');
    }
    if (!res.ok) {
      throw new DiscoveryFailedError(`GitHub API returned ${res.status} for ${url}`);
    }

    return (await res.json()) as T;
  }
}

export const githubDiscoveryProvider = new GitHubDiscoveryProvider();
