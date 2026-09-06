// Phase 24 — generic GitHub Tool checks (ai/tools/builtin/github.tool.ts)
// — distinct from Discovery Agent's own github.tool.ts (which wraps
// DiscoveryService/persisted Resources). This one makes its own live
// GitHub API calls (against the mock server every verify script uses)
// for repository metadata/branches/files/commits/pull requests/issues,
// ownership-checked via the same getOwnedAccount() every route uses.
import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { prisma } from '../src/db/prisma.js';
import { redis } from '../src/cache/redis.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { registerBuiltinTools } from '../src/ai/tools/builtin/index.js';
import type { AIContext } from '../src/ai/types/context.types.js';

registerBuiltinTools();

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-github-tool-credential';
const REPO_FULL_NAME = 'verify-github-tool-user/verify-github-tool-repo';

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }

    const respond = (body: unknown): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/user') {
      respond({
        id: 994488,
        login: 'verify-github-tool-user',
        name: 'Verify GitHub Tool User',
        html_url: 'https://github.com/verify-github-tool-user',
        public_repos: 1,
        followers: 0,
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/user/repos') {
      respond([
        {
          id: 9001,
          name: 'verify-github-tool-repo',
          full_name: REPO_FULL_NAME,
          private: false,
          html_url: `https://github.com/${REPO_FULL_NAME}`,
          description: 'fixture repo for the generic GitHub Tool',
          language: 'TypeScript',
          topics: [],
          stargazers_count: 3,
          forks_count: 1,
          default_branch: 'main',
        },
      ]);
      return;
    }
    if (req.method === 'GET' && req.url === '/user/orgs') {
      respond([]);
      return;
    }
    if (req.method === 'GET' && req.url === `/repos/${REPO_FULL_NAME}/branches`) {
      respond([
        { name: 'main', protected: true },
        { name: 'dev', protected: false },
      ]);
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith(`/repos/${REPO_FULL_NAME}/contents`)) {
      respond([{ name: 'README.md', path: 'README.md', type: 'file' }]);
      return;
    }
    if (req.method === 'GET' && req.url === `/repos/${REPO_FULL_NAME}/commits`) {
      respond([
        {
          sha: 'abc123',
          commit: {
            message: 'initial commit',
            author: { name: 'verify-user', date: '2026-01-01T00:00:00Z' },
          },
        },
      ]);
      return;
    }
    if (req.method === 'GET' && req.url === `/repos/${REPO_FULL_NAME}/pulls`) {
      respond([
        {
          number: 1,
          title: 'Fix branch protection',
          state: 'open',
          html_url: 'https://example.com/pr/1',
        },
      ]);
      return;
    }
    if (req.method === 'GET' && req.url === `/repos/${REPO_FULL_NAME}/issues`) {
      respond([
        {
          number: 5,
          title: 'Enable secret scanning',
          state: 'open',
          html_url: 'https://example.com/issues/5',
        },
        {
          number: 6,
          title: 'A PR disguised as an issue',
          state: 'open',
          html_url: 'https://example.com/issues/6',
          pull_request: {},
        },
      ]);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let accountId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let strangerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log(
      '0. setup — admin+category, asset, owner, connected GitHub account (real encrypted credential)',
    );
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('github-tool');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-github-tool-owner-${stamp}@example.test`);
    ownerId = owner.id;

    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-github-tool-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<{ id: string }>('POST', '/accounts/connect', owner.accessToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'GitHub Tool verification target',
    });
    accountId = connectRes.body.id;

    const ownerContext: AIContext = {
      user: { id: owner.id, role: 'USER' },
      toolHistory: [],
      executionHistory: [],
    };

    console.log("1. github_repository_info — fetches the connected account's repositories");
    const repoInfo = await aiFoundation.toolExecutor.run(
      'github_repository_info',
      { accountId },
      ownerContext,
      'copilot-agent',
    );
    check('repository_info succeeds', repoInfo.success === true, repoInfo.error);
    const repoOutput = repoInfo.output as {
      repositories: { fullName: string; language: string | null }[];
    };
    check(
      'repository fullName matches the fixture',
      repoOutput.repositories[0]?.fullName === REPO_FULL_NAME,
    );
    check(
      'repository language matches the fixture',
      repoOutput.repositories[0]?.language === 'TypeScript',
    );

    console.log('2. github_repo_branches — lists branches');
    const branchesResult = await aiFoundation.toolExecutor.run(
      'github_repo_branches',
      { accountId, repo: REPO_FULL_NAME },
      ownerContext,
      'copilot-agent',
    );
    check('branches succeeds', branchesResult.success === true, branchesResult.error);
    const branchesOutput = branchesResult.output as {
      branches: { name: string; protected: boolean }[];
    };
    check(
      'main branch is protected',
      branchesOutput.branches.some((b) => b.name === 'main' && b.protected),
    );
    check(
      'dev branch is not protected',
      branchesOutput.branches.some((b) => b.name === 'dev' && !b.protected),
    );

    console.log('3. github_list_files — lists repo contents');
    const filesResult = await aiFoundation.toolExecutor.run(
      'github_list_files',
      { accountId, repo: REPO_FULL_NAME },
      ownerContext,
      'copilot-agent',
    );
    check('list_files succeeds', filesResult.success === true, filesResult.error);
    const filesOutput = filesResult.output as { entries: { name: string }[] };
    check(
      'README.md is listed',
      filesOutput.entries.some((e) => e.name === 'README.md'),
    );

    console.log('4. github_commit_history — lists commits');
    const commitsResult = await aiFoundation.toolExecutor.run(
      'github_commit_history',
      { accountId, repo: REPO_FULL_NAME },
      ownerContext,
      'copilot-agent',
    );
    check('commit_history succeeds', commitsResult.success === true, commitsResult.error);
    const commitsOutput = commitsResult.output as { commits: { sha: string; message: string }[] };
    check('commit matches fixture', commitsOutput.commits[0]?.sha === 'abc123');

    console.log('5. github_list_pull_requests — lists PRs');
    const pullsResult = await aiFoundation.toolExecutor.run(
      'github_list_pull_requests',
      { accountId, repo: REPO_FULL_NAME },
      ownerContext,
      'copilot-agent',
    );
    check('list_pull_requests succeeds', pullsResult.success === true, pullsResult.error);
    const pullsOutput = pullsResult.output as { pullRequests: { number: number; title: string }[] };
    check(
      'PR #1 is listed',
      pullsOutput.pullRequests.some((p) => p.number === 1),
    );

    console.log('6. github_list_issues — lists issues, excluding pull requests');
    const issuesResult = await aiFoundation.toolExecutor.run(
      'github_list_issues',
      { accountId, repo: REPO_FULL_NAME },
      ownerContext,
      'copilot-agent',
    );
    check('list_issues succeeds', issuesResult.success === true, issuesResult.error);
    const issuesOutput = issuesResult.output as { issues: { number: number; title: string }[] };
    check(
      'issue #5 is listed',
      issuesOutput.issues.some((i) => i.number === 5),
    );
    check('issue #6 (a PR) is excluded', !issuesOutput.issues.some((i) => i.number === 6));

    console.log('7. ownership — a stranger cannot use the tool against this account');
    const stranger = await registerAndLogin(`verify-github-tool-stranger-${stamp}@example.test`);
    strangerId = stranger.id;
    const strangerContext: AIContext = {
      user: { id: stranger.id, role: 'USER' },
      toolHistory: [],
      executionHistory: [],
    };
    const strangerResult = await aiFoundation.toolExecutor.run(
      'github_repository_info',
      { accountId },
      strangerContext,
      'copilot-agent',
    );
    check('cross-user access is refused', strangerResult.success === false);

    console.log('8. agent allowlist — an agent not declared for github_* tools is denied');
    const deniedResult = await aiFoundation.toolExecutor.run(
      'github_repository_info',
      { accountId },
      ownerContext,
      'risk-agent',
    );
    check(
      'risk-agent (undeclared) is denied github_repository_info',
      deniedResult.success === false,
    );

    if (state.failed) {
      console.error('\nOne or more GitHub Tool checks FAILED.');
    } else {
      console.log('\nAll GitHub Tool checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    mockServer.close();
    if (accountId) await accountRepository.delete(accountId);
    if (assetId) await assetRepository.delete(assetId);
    if (categoryId) await categoryRepository.delete(categoryId);
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (strangerId) await userRepository.delete(strangerId);
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
