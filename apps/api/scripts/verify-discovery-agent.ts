// Phase 18 — Discovery Agent checks. Two parts, like the mixed shape a
// few other verify:* scripts use when a phase adds both HTTP routes and
// pure infrastructure: Part A drives the real HTTP surface
// (/ai/discovery/*) against a live server + worker + mock GitHub server,
// reusing the exact same mock convention verify-discovery.ts already
// established (GITHUB_USER_URL/REPOS_URL/ORGS_URL pointed at
// localhost:3999 via .env); Part B checks in-process pieces
// (aiFoundation.toolRegistry has every tool, orchestratorAgentRegistry
// has 'discovery-agent', provider.registry.ts's capability list, and
// that every placeholder tool correctly rejects) that don't need a
// running server.
import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { aiFoundation } from '../src/ai/foundation.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { ToolExecutionError } from '../src/ai/errors/index.js';
import {
  discoveryAgent,
  discoveryToolProviderRegistry,
  classifyDiscoveryIntent,
} from '../src/ai/agents/discovery/index.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-discovery-agent-credential';

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface JobDto {
  status: string;
  error?: string | null;
  result: {
    status?: string;
    resourceCount?: number;
    repositories?: unknown[];
    organizations?: unknown[];
    languages?: { language: string; repositoryCount: number }[];
    topics?: { topic: string; repositoryCount: number }[];
    relationships?: { created: number; updated: number; unchanged: number };
    summary?: string;
    confidenceScore?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
}
interface HistoryDto {
  items: { accountId: string; status: string; resourceCount: number }[];
}
interface StatusDto {
  status: string;
  resourceCount?: number;
}
interface ProvidersDto {
  items: { provider: string; implemented: boolean; tools: string[] }[];
}

async function pollJobSettled(jobId: string, token: string, timeoutMs = 15_000): Promise<JobDto> {
  const deadline = Date.now() + timeoutMs;
  let last: JobDto;
  do {
    const res = await api<JobDto>('GET', `/jobs/${jobId}`, token);
    last = res.body;
    if (last.status !== 'QUEUED' && last.status !== 'RUNNING') {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return last!;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);

    if (req.method === 'GET' && req.url === '/user') {
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 990033,
          login: 'verify-discovery-agent-user',
          name: 'Verify Discovery Agent User',
          html_url: 'https://github.com/verify-discovery-agent-user',
          public_repos: 2,
          followers: 1,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 3001,
            name: 'agent-repo-one',
            full_name: 'verify-discovery-agent-user/agent-repo-one',
            private: false,
            html_url: 'https://github.com/verify-discovery-agent-user/agent-repo-one',
            language: 'TypeScript',
            topics: ['security', 'backend'],
            stargazers_count: 4,
            forks_count: 1,
            default_branch: 'main',
          },
          {
            id: 3002,
            name: 'agent-repo-two',
            full_name: 'verify-discovery-agent-user/agent-repo-two',
            private: false,
            html_url: 'https://github.com/verify-discovery-agent-user/agent-repo-two',
            language: 'TypeScript',
            topics: ['security'],
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
          },
        ]),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 4001, login: 'verify-discovery-agent-org', description: 'Agent test org' },
        ]),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(MOCK_PORT, () => resolve(server));
  });
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('Part B first (no server dependency) — in-process registration checks');
  check(
    'discovery-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('discovery-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('discovery-agent') === discoveryAgent,
  );
  check('discoveryAgent.canHandle("discover repos")', discoveryAgent.canHandle('discover repos'));
  check(
    'discoveryAgent.canHandle("RISK_SUMMARY") is false',
    !discoveryAgent.canHandle('RISK_SUMMARY'),
  );

  for (const toolName of [
    'github_discover_repositories',
    'github_list_organizations',
    'github_summarize_languages',
    'github_summarize_topics',
    'github_list_branches',
    'github_list_contributors',
    'github_list_releases',
    'github_list_workflows',
    'github_list_security_advisories',
    'github_list_secret_scanning_alerts',
  ]) {
    check(`tool "${toolName}" is registered`, aiFoundation.toolRegistry.has(toolName));
  }

  const providers = discoveryToolProviderRegistry.list();
  check('provider registry lists 8 providers (1 implemented + 7 future)', providers.length === 8);
  check('github is implemented', discoveryToolProviderRegistry.isImplemented('github'));
  check('gitlab is not implemented', !discoveryToolProviderRegistry.isImplemented('gitlab'));
  check(
    'every future provider has zero tools',
    providers.filter((p) => p.provider !== 'github').every((p) => p.tools.length === 0),
  );

  let placeholderRejected = false;
  try {
    await aiFoundation.toolRegistry.execute(
      'github_list_branches',
      { accountId: 'irrelevant' },
      {
        user: { id: 'verify-user', role: 'USER' },
        toolHistory: [],
        executionHistory: [],
      },
    );
  } catch (e) {
    placeholderRejected = e instanceof ToolExecutionError;
  }
  check('placeholder tool (branches) rejects rather than returning fake data', placeholderRejected);

  const intent = classifyDiscoveryIntent('Refresh repository inventory for our GitHub org');
  check('classifyDiscoveryIntent detects REFRESH', intent.action === 'REFRESH');
  check('classifyDiscoveryIntent detects github provider', intent.provider === 'github');

  console.log('\nPart A — HTTP surface against a live server + mock GitHub');
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  const jobIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner, connected GitHub account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('discovery-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-discovery-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-discovery-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Discovery Agent target',
    });
    const accountId = connectRes.body.id;
    accountIds.push(accountId);

    console.log('1. unauthorized — /ai/discovery/start without a token is rejected');
    const noAuth = await api('POST', '/ai/discovery/start', undefined, { accountId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/discovery/start — enqueues an AI_DISCOVERY job (202)');
    const startRes = await api<EnqueueResponseDto>('POST', '/ai/discovery/start', ownerToken, {
      accountId,
      message: 'Discover all GitHub repositories',
    });
    check('status 202', startRes.status === 202, `${startRes.status}`);
    check('jobId present', typeof startRes.body.jobId === 'string');
    jobIds.push(startRes.body.jobId);

    console.log('3. job completes — DiscoveryAgentOutput-shaped result');
    const settled = await pollJobSettled(startRes.body.jobId, ownerToken);
    check('job status COMPLETED', settled.status === 'COMPLETED', settled.status);
    check('result.status is SUCCESS', settled.result?.status === 'SUCCESS', settled.result?.status);
    check(
      'resourceCount is 3 (2 repos + 1 org — the agent excludes the "user" resource type, unlike the raw DiscoveryResult)',
      settled.result?.resourceCount === 3,
      `${settled.result?.resourceCount}`,
    );
    check('repositories.length is 2', settled.result?.repositories?.length === 2);
    check('organizations.length is 1', settled.result?.organizations?.length === 1);
    check(
      'languages summary aggregates TypeScript x2',
      settled.result?.languages?.some(
        (l) => l.language === 'TypeScript' && l.repositoryCount === 2,
      ),
    );
    check(
      'topics summary includes "security" x2',
      settled.result?.topics?.some((t) => t.topic === 'security' && t.repositoryCount === 2),
    );
    check(
      'relationships summary present',
      typeof settled.result?.relationships?.created === 'number',
    );
    check(
      'summary is a non-empty string',
      typeof settled.result?.summary === 'string' && settled.result.summary.length > 0,
    );
    check(
      'confidenceScore is 1 for a clean success',
      settled.result?.confidenceScore === 1,
      `${settled.result?.confidenceScore}`,
    );
    check('no errors on a clean run', (settled.result?.errors?.length ?? -1) === 0);

    console.log('4. GET /ai/discovery/history — returns the run just completed');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/discovery/history?accountId=${accountId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      "history includes this account's run",
      historyRes.body.items.some(
        (item) => item.accountId === accountId && item.status === 'SUCCESS',
      ),
    );

    console.log('5. GET /ai/discovery/status?accountId= — reflects the last run');
    const statusRes = await api<StatusDto>(
      'GET',
      `/ai/discovery/status?accountId=${accountId}`,
      ownerToken,
    );
    check('status endpoint 200', statusRes.status === 200, `${statusRes.status}`);
    check('status reflects SUCCESS', statusRes.body.status === 'SUCCESS', statusRes.body.status);

    console.log('6. GET /ai/discovery/status?jobId= — delegates to the job record');
    const jobStatusRes = await api<{ status: string }>(
      'GET',
      `/ai/discovery/status?jobId=${startRes.body.jobId}`,
      ownerToken,
    );
    check('job-scoped status 200', jobStatusRes.status === 200);
    check('job-scoped status COMPLETED', jobStatusRes.body.status === 'COMPLETED');

    console.log('7. GET /ai/discovery/providers — github implemented, others listed as future');
    const providersRes = await api<ProvidersDto>('GET', '/ai/discovery/providers', ownerToken);
    check('providers status 200', providersRes.status === 200);
    check(
      'github is implemented over HTTP too',
      providersRes.body.items.find((p) => p.provider === 'github')?.implemented === true,
    );
    check(
      'kubernetes listed as not implemented',
      providersRes.body.items.find((p) => p.provider === 'kubernetes')?.implemented === false,
    );

    console.log('8. POST /ai/discovery/refresh — same underlying flow, distinct endpoint');
    const refreshRes = await api<EnqueueResponseDto>('POST', '/ai/discovery/refresh', ownerToken, {
      accountId,
    });
    check('refresh status 202', refreshRes.status === 202, `${refreshRes.status}`);
    jobIds.push(refreshRes.body.jobId);
    const refreshSettled = await pollJobSettled(refreshRes.body.jobId, ownerToken);
    check('refresh job COMPLETED', refreshSettled.status === 'COMPLETED', refreshSettled.status);

    console.log(
      '9. unsupported agent provider — permanent failure, job goes straight to FAILED (not retried, not a 500/crash)',
    );
    const unknownConnectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'totally-unsupported-agent-provider',
      credential: 'irrelevant',
      displayName: 'Unsupported provider target',
    });
    accountIds.push(unknownConnectRes.body.id);
    const unknownStartRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/discovery/start',
      ownerToken,
      {
        accountId: unknownConnectRes.body.id,
      },
    );
    jobIds.push(unknownStartRes.body.jobId);
    const unknownSettled = await pollJobSettled(unknownStartRes.body.jobId, ownerToken);
    check(
      'job status is FAILED (permanent, not retried — mirrors UnsupportedDiscoveryProviderError)',
      unknownSettled.status === 'FAILED',
      unknownSettled.status,
    );
    check(
      'job error mentions the unsupported provider',
      typeof unknownSettled.error === 'string' &&
        unknownSettled.error.includes('totally-unsupported-agent-provider'),
      unknownSettled.error ?? '(none)',
    );

    console.log('10. cross-user access — history/status are ownership-checked');
    const stranger = await registerAndLogin(
      `verify-discovery-agent-stranger-${stamp}@example.test`,
    );
    const strangerHistoryRes = await api(
      'GET',
      `/ai/discovery/history?accountId=${accountId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Discovery Agent checks FAILED.');
    } else {
      console.log('\nAll Discovery Agent checks passed.');
    }
  } finally {
    console.log('11. cleanup');
    mockServer.close();
    for (const id of jobIds) {
      await jobRepository.delete(id);
    }
    console.log('   jobs deleted:', jobIds.length);
    for (const id of accountIds) {
      await accountRepository.delete(id);
    }
    console.log('   accounts deleted:', accountIds.length);
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    console.log('   users deleted');
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
