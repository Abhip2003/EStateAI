import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { resourceRepository } from '../src/repositories/resource.repository.js';
import { relationshipRepository } from '../src/repositories/relationship.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'graph-credential-good';
const USER_ID = 990044;
const REPO_ID = 5101;
const ORG_ID = 6101;
const ORG_LOGIN = 'verify-graph-org';

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface GraphCounts {
  created: number;
  updated: number;
  unchanged: number;
}

interface JobDto {
  status: string;
  result: { success?: boolean; graph?: GraphCounts } | null;
}

interface ResourceDto {
  id: string;
  resourceType: string;
  providerResourceId: string;
  displayName: string;
}

interface ResourceListDto {
  items: ResourceDto[];
  total: number;
}

interface ItemsDto {
  items: ResourceDto[];
}

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
          id: USER_ID,
          login: 'verify-graph-user',
          name: 'Verify Graph User',
          html_url: 'https://github.com/verify-graph-user',
          public_repos: 1,
          followers: 0,
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
            id: REPO_ID,
            name: 'repo-in-org',
            // Prefixed with the org login — GitHubRelationshipExtractor
            // derives an org --contains--> repo edge from exactly this.
            full_name: `${ORG_LOGIN}/repo-in-org`,
            description: 'A repo inside an org',
            private: false,
            html_url: `https://github.com/${ORG_LOGIN}/repo-in-org`,
            language: 'TypeScript',
            stargazers_count: 1,
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
      res.end(JSON.stringify([{ id: ORG_ID, login: ORG_LOGIN, description: 'Graph test org' }]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
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
  let otherId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner + another user, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('graph');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-graph-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-graph-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-graph-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Graph target',
    });
    accountId = connectRes.body.id;

    console.log('1. relationship creation — first discovery extracts 3 edges');
    const firstRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', firstRun.status === 'COMPLETED', firstRun.status);
    check(
      'graph.created is 3',
      firstRun.result?.graph?.created === 3,
      JSON.stringify(firstRun.result?.graph),
    );

    const userResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(USER_ID),
    );
    const repoResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_ID),
    );
    const orgResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(ORG_ID),
    );
    check('user resource exists', userResource !== null);
    check('repo resource exists', repoResource !== null);
    check('org resource exists', orgResource !== null);
    const userId = userResource!.id;
    const repoId = repoResource!.id;
    const orgId = orgResource!.id;

    console.log('2. duplicate prevention — identical rediscovery creates no new edges');
    const secondRun = await runDiscovery(accountId, ownerToken);
    check(
      'graph.created is 0',
      secondRun.result?.graph?.created === 0,
      JSON.stringify(secondRun.result?.graph),
    );
    check('graph.unchanged is 3', secondRun.result?.graph?.unchanged === 3);

    console.log('3. unauthorized — resource routes require a token');
    const noAuth = await api('GET', `/resources?assetId=${assetId}`, undefined);
    check('status', noAuth.status === 401, `${noAuth.status}`);

    console.log("4. cross-user isolation — another user cannot read owner's resource");
    const crossGet = await api('GET', `/resources/${userId}`, other.accessToken);
    check('status', crossGet.status === 403, `${crossGet.status}`);

    console.log('5. children — user points to repo (owns) and org (member_of)');
    const userChildren = await api<ItemsDto>('GET', `/resources/${userId}/children`, ownerToken);
    check('status', userChildren.status === 200, `${userChildren.status}`);
    check(
      'children are repo + org',
      userChildren.body.items.length === 2 &&
        userChildren.body.items.some((r) => r.id === repoId) &&
        userChildren.body.items.some((r) => r.id === orgId),
    );

    console.log('6. parents — repo is pointed to by user (owns) and org (contains)');
    const repoParents = await api<ItemsDto>('GET', `/resources/${repoId}/parents`, ownerToken);
    check('status', repoParents.status === 200, `${repoParents.status}`);
    check(
      'parents are user + org',
      repoParents.body.items.length === 2 &&
        repoParents.body.items.some((r) => r.id === userId) &&
        repoParents.body.items.some((r) => r.id === orgId),
    );

    console.log('7. neighbors — repo neighbors are user + org regardless of edge direction');
    const repoNeighbors = await api<ItemsDto>('GET', `/resources/${repoId}/neighbors`, ownerToken);
    check(
      'neighbors are user + org',
      repoNeighbors.body.items.length === 2 &&
        repoNeighbors.body.items.some((r) => r.id === userId) &&
        repoNeighbors.body.items.some((r) => r.id === orgId),
    );

    console.log('8. graph traversal — connectedResources reaches every resource from the user');
    const connected = await api<ItemsDto>('GET', `/resources/${userId}/connected`, ownerToken);
    check(
      'connected includes repo + org',
      connected.body.items.some((r) => r.id === repoId) &&
        connected.body.items.some((r) => r.id === orgId),
    );

    console.log(
      '9. path exists — user to org (direct edge) and user to a nonexistent id (no path)',
    );
    const pathYes = await api<{ pathExists: boolean }>(
      'GET',
      `/resources/${userId}/path/${orgId}`,
      ownerToken,
    );
    check('pathExists is true', pathYes.body.pathExists === true);
    const pathNo = await api<{ pathExists: boolean }>(
      'GET',
      `/resources/${userId}/path/not-a-real-resource-id`,
      ownerToken,
    );
    check('pathExists is false for an unreachable id', pathNo.body.pathExists === false);

    console.log('10. search — by name, provider, type, relationship, metadata, with pagination');
    const byName = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&name=repo-in-org`,
      ownerToken,
    );
    check(
      'name search finds the repo',
      byName.body.items.some((r) => r.id === repoId),
    );

    const byType = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&resourceType=organization`,
      ownerToken,
    );
    check(
      'type filter returns only the org',
      byType.body.items.length === 1 && byType.body.items[0]?.id === orgId,
    );

    const byRelationship = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&relationshipType=owns`,
      ownerToken,
    );
    check(
      'relationship filter returns user + repo (endpoints of "owns")',
      byRelationship.body.items.length === 2 &&
        byRelationship.body.items.some((r) => r.id === userId) &&
        byRelationship.body.items.some((r) => r.id === repoId),
    );

    const byMetadata = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&metadataKey=language&metadataValue=TypeScript`,
      ownerToken,
    );
    check(
      'metadata filter finds the repo',
      byMetadata.body.items.some((r) => r.id === repoId),
    );

    const page1 = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&limit=1&page=1&sort=displayName&order=asc`,
      ownerToken,
    );
    const page2 = await api<ResourceListDto>(
      'GET',
      `/resources?assetId=${assetId}&limit=1&page=2&sort=displayName&order=asc`,
      ownerToken,
    );
    check('pagination — total is 3', page1.body.total === 3, `${page1.body.total}`);
    check('pagination — page1 has 1 item', page1.body.items.length === 1);
    check(
      'pagination — page1 and page2 differ',
      page1.body.items[0]?.id !== page2.body.items[0]?.id,
    );

    console.log('11. event generation — RELATIONSHIP_CREATED and GRAPH_UPDATED fired');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    check(
      'RELATIONSHIP_CREATED event exists',
      eventsRes.body.items.some((e) => e.type === 'RELATIONSHIP_CREATED'),
    );
    check(
      'GRAPH_UPDATED event exists',
      eventsRes.body.items.some((e) => e.type === 'GRAPH_UPDATED'),
    );

    if (state.failed) {
      console.error('\nOne or more graph checks FAILED.');
    } else {
      console.log('\nAll graph checks passed.');
    }
  } finally {
    console.log('12. cleanup');
    mockServer.close();
    for (const providerResourceId of [String(USER_ID), String(REPO_ID), String(ORG_ID)]) {
      const row = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (row) {
        const outgoing = await relationshipRepository.findByFromResource(row.id);
        const incoming = await relationshipRepository.findByToResource(row.id);
        for (const rel of [...outgoing, ...incoming]) {
          await relationshipRepository.delete(rel.id);
        }
        await resourceRepository.delete(row.id);
      }
    }
    console.log('   resources + relationships deleted');
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
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
