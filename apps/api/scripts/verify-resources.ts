import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { resourceRepository } from '../src/repositories/resource.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'resources-credential-good';

interface RepoFixture {
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
}

// Mutated between discovery runs to exercise update/unchanged/delete/
// rediscovery — the mock server always reflects whatever this currently
// holds.
let repoFixtures: RepoFixture[] = [
  {
    id: 5001,
    name: 'repo-one',
    full_name: 'verify-resources-user/repo-one',
    description: 'Original description',
    private: false,
    html_url: 'https://github.com/verify-resources-user/repo-one',
    language: 'TypeScript',
    stargazers_count: 10,
    forks_count: 2,
    default_branch: 'main',
  },
  {
    id: 5002,
    name: 'repo-two',
    full_name: 'verify-resources-user/repo-two',
    description: 'Repo two',
    private: false,
    html_url: 'https://github.com/verify-resources-user/repo-two',
    language: 'Python',
    stargazers_count: 0,
    forks_count: 0,
    default_branch: 'main',
  },
];

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);

    if (req.method === 'GET' && req.url === '/user') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 990033,
          login: 'verify-resources-user',
          name: 'Verify Resources User',
          html_url: 'https://github.com/verify-resources-user',
          public_repos: repoFixtures.length,
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
      res.end(JSON.stringify(repoFixtures));
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 6001, login: 'verify-resources-org', description: 'Org' }]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

interface EnqueueResponseDto {
  jobId: string;
}

interface PersistedCounts {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

interface JobDto {
  status: string;
  result: { success?: boolean; persisted?: PersistedCounts } | null;
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

async function runDiscovery(accountId: string, token: string): Promise<JobDto> {
  const enqueueRes = await api<EnqueueResponseDto>(
    'POST',
    `/accounts/${accountId}/discover`,
    token,
  );
  return pollJobSettled(enqueueRes.body.jobId, token);
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let accountId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('resources');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-resources-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-resources-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<{ id: string }>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Resources target',
    });
    accountId = connectRes.body.id;

    console.log('1. insert — first discovery creates 4 resources (1 user + 2 repos + 1 org)');
    const firstRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', firstRun.status === 'COMPLETED', firstRun.status);
    check(
      'created is 4',
      firstRun.result?.persisted?.created === 4,
      JSON.stringify(firstRun.result?.persisted),
    );
    check('updated is 0', firstRun.result?.persisted?.updated === 0);
    check('deleted is 0', firstRun.result?.persisted?.deleted === 0);

    const repoOneRow = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      '5001',
    );
    check('repo-one row exists', repoOneRow !== null);
    check(
      'firstSeen equals lastSeen on creation',
      repoOneRow?.firstSeen.getTime() === repoOneRow?.lastSeen.getTime(),
    );
    const firstHash = repoOneRow?.hash;

    console.log('2. duplicate prevention — identical rediscovery creates nothing new');
    const secondRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', secondRun.status === 'COMPLETED', secondRun.status);
    check(
      'created is 0',
      secondRun.result?.persisted?.created === 0,
      JSON.stringify(secondRun.result?.persisted),
    );
    check('unchanged is 4', secondRun.result?.persisted?.unchanged === 4);
    const repoOneAfterDup = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      '5001',
    );
    check('hash unchanged', repoOneAfterDup?.hash === firstHash);

    console.log('3. hash changes — updating repo-one content is detected and persisted');
    repoFixtures = repoFixtures.map((r) =>
      r.id === 5001 ? { ...r, description: 'Updated description', stargazers_count: 99 } : r,
    );
    const thirdRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', thirdRun.status === 'COMPLETED', thirdRun.status);
    check(
      'updated is 1',
      thirdRun.result?.persisted?.updated === 1,
      JSON.stringify(thirdRun.result?.persisted),
    );
    check('unchanged is 3', thirdRun.result?.persisted?.unchanged === 3);
    const repoOneAfterUpdate = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      '5001',
    );
    check('hash changed', repoOneAfterUpdate?.hash !== firstHash);
    check(
      'description updated',
      repoOneAfterUpdate?.description === 'Updated description',
      repoOneAfterUpdate?.description ?? 'null',
    );
    check(
      'lastSeen advanced past firstSeen',
      (repoOneAfterUpdate?.lastSeen.getTime() ?? 0) >
        (repoOneAfterUpdate?.firstSeen.getTime() ?? 0),
    );

    console.log('4. soft delete — dropping repo-two from the provider soft-deletes its row');
    repoFixtures = repoFixtures.filter((r) => r.id !== 5002);
    const fourthRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', fourthRun.status === 'COMPLETED', fourthRun.status);
    check(
      'deleted is 1',
      fourthRun.result?.persisted?.deleted === 1,
      JSON.stringify(fourthRun.result?.persisted),
    );
    const repoTwoRow = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      '5002',
    );
    check('repo-two row still exists (soft, not hard, delete)', repoTwoRow !== null);
    check('repo-two deletedAt is set', repoTwoRow?.deletedAt !== null);
    const activeAfterDelete = await resourceRepository.findActiveByAccount(accountId);
    check(
      'repo-two excluded from active resources',
      !activeAfterDelete.some((r) => r.providerResourceId === '5002'),
    );

    console.log('5. rediscovery — restoring repo-two undeletes it and counts as a fresh create');
    repoFixtures = [
      ...repoFixtures,
      {
        id: 5002,
        name: 'repo-two',
        full_name: 'verify-resources-user/repo-two',
        description: 'Repo two',
        private: false,
        html_url: 'https://github.com/verify-resources-user/repo-two',
        language: 'Python',
        stargazers_count: 0,
        forks_count: 0,
        default_branch: 'main',
      },
    ];
    const fifthRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', fifthRun.status === 'COMPLETED', fifthRun.status);
    check(
      'created is 1 (rediscovered)',
      fifthRun.result?.persisted?.created === 1,
      JSON.stringify(fifthRun.result?.persisted),
    );
    const repoTwoAfterRediscovery = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      '5002',
    );
    check('repo-two deletedAt cleared', repoTwoAfterRediscovery?.deletedAt === null);

    console.log('6. events — RESOURCE_CREATED/UPDATED/DELETED/DISCOVERED all fired');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events`,
      ownerToken,
    );
    for (const type of [
      'RESOURCE_CREATED',
      'RESOURCE_UPDATED',
      'RESOURCE_DELETED',
      'RESOURCE_DISCOVERED',
    ]) {
      check(
        `${type} event exists`,
        eventsRes.body.items.some((e) => e.type === type),
      );
    }

    if (state.failed) {
      console.error('\nOne or more resource checks FAILED.');
    } else {
      console.log('\nAll resource checks passed.');
    }
  } finally {
    console.log('7. cleanup');
    mockServer.close();
    for (const providerResourceId of ['990033', '5001', '5002', '6001']) {
      const row = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (row) await resourceRepository.delete(row.id);
    }
    console.log('   resources deleted');
    if (accountId) {
      const jobs = await jobRepository.list({ accountId, page: 1, limit: 50 });
      for (const job of jobs.items) {
        await jobRepository.delete(job.id);
      }
      await accountRepository.delete(accountId);
    }
    console.log('   account + jobs deleted');
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
