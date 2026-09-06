import { z } from 'zod';
import type { ToolDefinition } from '../tool.types.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { AIContext } from '../../types/context.types.js';
import { ToolError } from '../tool-error.js';
import { config } from '../../../config/env.js';
import { getOwnedAccount } from '../../../services/assets/account.service.js';
import { credentialEncryptionService } from '../../../services/credential-encryption.service.js';
import type { Requester } from '../../../services/assets/ownership.js';

// Generic, agent-agnostic GitHub Tool (Phase 24 spec #4) — every agent
// that has 'github_*' access (agent-tool-access.ts) shares these
// definitions, unlike Discovery Agent's own github.tool.ts (which wraps
// DiscoveryService/persisted Resources, not live GitHub reads). This
// file makes its own read-only REST calls, self-contained the same way
// GitHubDiscoveryProvider/GitHubSyncProvider each independently call the
// GitHub API rather than sharing a client — an established pattern in
// this codebase, not a new one.

function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

function authHeaders(credential: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'EstateAI',
  };
}

// Resolves the account's decrypted credential after an ownership check —
// every tool in this file calls this first, so "you don't own this
// account" always surfaces as the ownership error (ForbiddenError/
// AccountNotFoundError), never a GitHub 401.
async function resolveCredential(accountId: string, context: AIContext): Promise<string> {
  const account = await getOwnedAccount(accountId, toRequester(context));
  if (!account.credentialCiphertext) {
    throw new ToolError('github', `account "${accountId}" has no stored credential`);
  }
  return credentialEncryptionService.decrypt(account.credentialCiphertext);
}

async function githubGet<T>(path: string, credential: string, toolName: string): Promise<T> {
  const res = await fetch(`${config.oauth.github.apiBaseUrl}${path}`, {
    headers: authHeaders(credential),
  });
  if (!res.ok) {
    throw new ToolError(toolName, `GitHub API request failed (${res.status}): ${path}`);
  }
  return (await res.json()) as T;
}

const accountInputSchema = z.object({ accountId: z.string().min(1) });
const repoInputSchema = z.object({ accountId: z.string().min(1), repo: z.string().min(1) });
const repoOptionalPathInputSchema = z.object({
  accountId: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().optional(),
});

const repositoryInfoOutputSchema = z.object({
  repositories: z.array(
    z.object({
      fullName: z.string(),
      description: z.string().nullable(),
      private: z.boolean(),
      defaultBranch: z.string(),
      language: z.string().nullable(),
      stargazersCount: z.number(),
      forksCount: z.number(),
    }),
  ),
});

export const githubRepositoryInfoTool: ToolDefinition<
  z.infer<typeof accountInputSchema>,
  z.infer<typeof repositoryInfoOutputSchema>
> = {
  id: 'github_repository_info',
  name: 'github_repository_info',
  description:
    "Fetches the connected GitHub account's repositories (metadata: name, visibility, default branch, language, stars/forks).",
  permissions: ['read', 'network'],
  inputSchema: accountInputSchema,
  outputSchema: repositoryInfoOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface RepoResponse {
      full_name: string;
      description: string | null;
      private: boolean;
      default_branch: string;
      language: string | null;
      stargazers_count: number;
      forks_count: number;
    }
    const repos = await githubGet<RepoResponse[]>(
      '/user/repos',
      credential,
      'github_repository_info',
    );
    return {
      repositories: repos.map((repo) => ({
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.default_branch,
        language: repo.language,
        stargazersCount: repo.stargazers_count,
        forksCount: repo.forks_count,
      })),
    };
  },
};

const branchesOutputSchema = z.object({
  branches: z.array(z.object({ name: z.string(), protected: z.boolean() })),
});

export const githubListBranchesTool: ToolDefinition<
  z.infer<typeof repoInputSchema>,
  z.infer<typeof branchesOutputSchema>
> = {
  id: 'github_repo_branches',
  name: 'github_repo_branches',
  description: 'Lists branches for one repository ("owner/name").',
  permissions: ['read', 'network'],
  inputSchema: repoInputSchema,
  outputSchema: branchesOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface BranchResponse {
      name: string;
      protected: boolean;
    }
    const branches = await githubGet<BranchResponse[]>(
      `/repos/${input.repo}/branches`,
      credential,
      'github_repo_branches',
    );
    return { branches: branches.map((b) => ({ name: b.name, protected: b.protected })) };
  },
};

const filesOutputSchema = z.object({
  entries: z.array(z.object({ name: z.string(), path: z.string(), type: z.string() })),
});

export const githubListFilesTool: ToolDefinition<
  z.infer<typeof repoOptionalPathInputSchema>,
  z.infer<typeof filesOutputSchema>
> = {
  id: 'github_list_files',
  name: 'github_list_files',
  description: 'Lists files/directories at a path (default: repo root) in one repository.',
  permissions: ['read', 'network'],
  inputSchema: repoOptionalPathInputSchema,
  outputSchema: filesOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface ContentResponse {
      name: string;
      path: string;
      type: string;
    }
    const contents = await githubGet<ContentResponse[]>(
      `/repos/${input.repo}/contents/${input.path ?? ''}`,
      credential,
      'github_list_files',
    );
    return { entries: contents.map((c) => ({ name: c.name, path: c.path, type: c.type })) };
  },
};

const commitsOutputSchema = z.object({
  commits: z.array(
    z.object({
      sha: z.string(),
      message: z.string(),
      author: z.string().nullable(),
      date: z.string().nullable(),
    }),
  ),
});

export const githubCommitHistoryTool: ToolDefinition<
  z.infer<typeof repoInputSchema>,
  z.infer<typeof commitsOutputSchema>
> = {
  id: 'github_commit_history',
  name: 'github_commit_history',
  description: 'Lists recent commits for one repository.',
  permissions: ['read', 'network'],
  inputSchema: repoInputSchema,
  outputSchema: commitsOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface CommitResponse {
      sha: string;
      commit: { message: string; author: { name: string; date: string } | null };
    }
    const commits = await githubGet<CommitResponse[]>(
      `/repos/${input.repo}/commits`,
      credential,
      'github_commit_history',
    );
    return {
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name ?? null,
        date: c.commit.author?.date ?? null,
      })),
    };
  },
};

const pullRequestsOutputSchema = z.object({
  pullRequests: z.array(
    z.object({ number: z.number(), title: z.string(), state: z.string(), url: z.string() }),
  ),
});

export const githubListPullRequestsTool: ToolDefinition<
  z.infer<typeof repoInputSchema>,
  z.infer<typeof pullRequestsOutputSchema>
> = {
  id: 'github_list_pull_requests',
  name: 'github_list_pull_requests',
  description: 'Lists pull requests (open by default) for one repository.',
  permissions: ['read', 'network'],
  inputSchema: repoInputSchema,
  outputSchema: pullRequestsOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface PullResponse {
      number: number;
      title: string;
      state: string;
      html_url: string;
    }
    const pulls = await githubGet<PullResponse[]>(
      `/repos/${input.repo}/pulls`,
      credential,
      'github_list_pull_requests',
    );
    return {
      pullRequests: pulls.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        url: p.html_url,
      })),
    };
  },
};

const issuesOutputSchema = z.object({
  issues: z.array(
    z.object({ number: z.number(), title: z.string(), state: z.string(), url: z.string() }),
  ),
});

export const githubListIssuesTool: ToolDefinition<
  z.infer<typeof repoInputSchema>,
  z.infer<typeof issuesOutputSchema>
> = {
  id: 'github_list_issues',
  name: 'github_list_issues',
  description: 'Lists issues (open by default, excludes pull requests) for one repository.',
  permissions: ['read', 'network'],
  inputSchema: repoInputSchema,
  outputSchema: issuesOutputSchema,
  async execute(input, context) {
    const credential = await resolveCredential(input.accountId, context);
    interface IssueResponse {
      number: number;
      title: string;
      state: string;
      html_url: string;
      pull_request?: unknown;
    }
    const issues = await githubGet<IssueResponse[]>(
      `/repos/${input.repo}/issues`,
      credential,
      'github_list_issues',
    );
    return {
      issues: issues
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url })),
    };
  },
};

export function registerGitHubTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(githubRepositoryInfoTool);
  toolRegistry.register(githubListBranchesTool);
  toolRegistry.register(githubListFilesTool);
  toolRegistry.register(githubCommitHistoryTool);
  toolRegistry.register(githubListPullRequestsTool);
  toolRegistry.register(githubListIssuesTool);
}
