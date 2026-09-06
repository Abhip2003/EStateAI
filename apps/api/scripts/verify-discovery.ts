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

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-discovery-credential';

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
  status: string;
}

interface DiscoveredResourceDto {
  provider: string;
  providerResourceId: string;
  resourceType: string;
  displayName: string;
  metadata: Record<string, unknown>;
  discoveredAt: string;
}

interface JobDto {
  status: string;
  result: {
    success?: boolean;
    resources?: DiscoveredResourceDto[];
    resourceCount?: number;
  } | null;
}

interface EventDto {
  type: string;
  metadata: { accountId?: string } | null;
}

interface EventListDto {
  items: EventDto[];
}

// Phase 4 turned /accounts/:id/discover into an async enqueue — poll
// GET /jobs/:id the way a real client would.
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

// GitHubDiscoveryProvider hits GITHUB_USER_URL / GITHUB_REPOS_URL /
// GITHUB_ORGS_URL, all pointed at this mock via .env.
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
          id: 990022,
          login: 'verify-discovery-user',
          name: 'Verify Discovery User',
          html_url: 'https://github.com/verify-discovery-user',
          public_repos: 2,
          followers: 5,
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
            id: 1001,
            name: 'repo-one',
            full_name: 'verify-discovery-user/repo-one',
            private: false,
            html_url: 'https://github.com/verify-discovery-user/repo-one',
            language: 'TypeScript',
            stargazers_count: 12,
            forks_count: 3,
            default_branch: 'main',
          },
          {
            id: 1002,
            name: 'repo-two',
            full_name: 'verify-discovery-user/repo-two',
            private: true,
            html_url: 'https://github.com/verify-discovery-user/repo-two',
            language: 'Python',
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
        JSON.stringify([{ id: 2001, login: 'verify-discovery-org', description: 'Test org' }]),
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
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  const jobIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('discovery');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-discovery-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-discovery-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Discovery target',
    });
    const accountId = connectRes.body.id;
    accountIds.push(accountId);

    console.log('1. unauthorized — discovery without a token is rejected');
    const noAuth = await api('POST', `/accounts/${accountId}/discover`, undefined);
    check('status', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. enqueue — POST /accounts/:id/discover returns a job envelope (202)');
    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    check('status', enqueueRes.status === 202, `${enqueueRes.status}`);
    check('jobId present', typeof enqueueRes.body.jobId === 'string');
    jobIds.push(enqueueRes.body.jobId);

    console.log('3. discovery succeeds — job completes with a DiscoveryResult-shaped result');
    const settled = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('job status is COMPLETED', settled.status === 'COMPLETED', settled.status);
    check('result.success is true', settled.result?.success === true);

    console.log('4. resourceCount correct — 1 user + 2 repos + 1 org = 4');
    check(
      'resourceCount is 4',
      settled.result?.resourceCount === 4,
      `${settled.result?.resourceCount}`,
    );
    check(
      'resources.length matches resourceCount',
      settled.result?.resources?.length === settled.result?.resourceCount,
    );

    console.log('5. normalized DTOs returned — every resource has the common shape');
    const resources = settled.result?.resources ?? [];
    const shapeOk = resources.every(
      (r) =>
        typeof r.provider === 'string' &&
        typeof r.providerResourceId === 'string' &&
        typeof r.resourceType === 'string' &&
        typeof r.displayName === 'string' &&
        typeof r.metadata === 'object' &&
        typeof r.discoveredAt === 'string',
    );
    check('every resource matches DiscoveredResource shape', shapeOk);
    check(
      'resourceType set is {user, repository, organization}',
      new Set(resources.map((r) => r.resourceType)).size === 3,
    );

    console.log('6. provider-specific objects never leave provider — no raw GitHub field names');
    const raw = JSON.stringify(settled.result);
    const leakedKeys = [
      'stargazers_count',
      'forks_count',
      'full_name',
      'default_branch',
      'html_url',
      'public_repos',
    ];
    const leaked = leakedKeys.filter((key) => raw.includes(`"${key}"`));
    check('no raw GitHub field names in the response', leaked.length === 0, leaked.join(', '));

    console.log(
      '7. AssetEvents generated — DiscoveryService still emits its own DISCOVERY_* events',
    );
    const eventsRes = await api<EventListDto>('GET', `/assets/${assetId}/events`, ownerToken);
    const startedEvent = eventsRes.body.items.find(
      (e) => e.type === 'DISCOVERY_STARTED' && e.metadata?.accountId === accountId,
    );
    const completedEvent = eventsRes.body.items.find(
      (e) => e.type === 'DISCOVERY_COMPLETED' && e.metadata?.accountId === accountId,
    );
    check('DISCOVERY_STARTED event exists', startedEvent !== undefined);
    check('DISCOVERY_COMPLETED event exists', completedEvent !== undefined);

    console.log('8. unsupported provider — permanent failure, job goes straight to FAILED');
    const unknownConnectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'totally-unsupported-provider',
      credential: 'irrelevant',
      displayName: 'Unsupported provider target',
    });
    accountIds.push(unknownConnectRes.body.id);
    const unknownEnqueue = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${unknownConnectRes.body.id}/discover`,
      ownerToken,
    );
    jobIds.push(unknownEnqueue.body.jobId);
    const unknownSettled = await pollJobSettled(unknownEnqueue.body.jobId, ownerToken);
    check(
      'job status is FAILED (permanent, not retried)',
      unknownSettled.status === 'FAILED',
      unknownSettled.status,
    );

    if (state.failed) {
      console.error('\nOne or more discovery checks FAILED.');
    } else {
      console.log('\nAll discovery checks passed.');
    }
  } finally {
    console.log('9. cleanup');
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
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
