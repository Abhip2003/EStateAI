import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { resourceRepository } from '../src/repositories/resource.repository.js';
import { relationshipRepository } from '../src/repositories/relationship.repository.js';
import { findingRepository } from '../src/repositories/finding.repository.js';
import { recommendationRepository } from '../src/repositories/recommendation.repository.js';
import { riskScoreRepository } from '../src/repositories/risk-score.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'analysis-credential-good';
const USER_ID = 880011;
const REPO_A_ID = 7201;
const REPO_B_ID = 7202;

interface RepoFixture {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  topics: string[];
  size: number;
}

// Run 1: repo A has every issue the 5 rules detect; repo B is clean.
// Run 2 (mutated below, after run 1 completes): repo A is fixed (all 4
// findings should resolve); repo B becomes archived (1 new finding).
const repoFixtures: RepoFixture[] = [
  {
    id: REPO_A_ID,
    name: 'broken-repo',
    description: null,
    private: false,
    archived: false,
    topics: [],
    size: 0,
  },
  {
    id: REPO_B_ID,
    name: 'clean-repo',
    description: 'A clean repo',
    private: true,
    archived: false,
    topics: ['ok'],
    size: 10,
  },
];

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface AnalysisCounts {
  rulesExecuted: number;
  resourcesEvaluated: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsResolved: number;
  recommendationsGenerated: number;
  durationMs: number;
}

interface JobDto {
  status: string;
  result: { success?: boolean; analysis?: AnalysisCounts } | null;
}

interface FindingDto {
  id: string;
  resourceId: string;
  ruleCode: string;
  severity: string;
  status: string;
}

interface FindingListDto {
  items: FindingDto[];
  total: number;
}

interface RecommendationDto {
  id: string;
  findingId: string;
  status: string;
  priority: string;
}

interface RecommendationListDto {
  items: RecommendationDto[];
}

interface RiskScoreDto {
  overallScore: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  informationalCount: number;
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
          login: 'verify-analysis-user',
          name: 'Verify Analysis User',
          html_url: 'https://github.com/verify-analysis-user',
          public_repos: repoFixtures.length,
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
        JSON.stringify(
          repoFixtures.map((repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: `verify-analysis-user/${repo.name}`,
            description: repo.description,
            private: repo.private,
            html_url: `https://github.com/verify-analysis-user/${repo.name}`,
            language: 'TypeScript',
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
            archived: repo.archived,
            topics: repo.topics,
            size: repo.size,
          })),
        ),
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
      res.end(JSON.stringify([]));
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
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('analysis');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-analysis-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-analysis-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-analysis-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Analysis target',
    });
    accountId = connectRes.body.id;

    console.log('1. rule execution + finding generation — broken-repo triggers all 4 rules');
    const firstRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', firstRun.status === 'COMPLETED', firstRun.status);
    const firstAnalysis = firstRun.result?.analysis;
    check('rulesExecuted > 0', (firstAnalysis?.rulesExecuted ?? 0) > 0);
    check('resourcesEvaluated is 3', firstAnalysis?.resourcesEvaluated === 3);
    check(
      'findingsCreated is 4',
      firstAnalysis?.findingsCreated === 4,
      JSON.stringify(firstAnalysis),
    );
    check('recommendationsGenerated is 4', firstAnalysis?.recommendationsGenerated === 4);

    const repoAResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_A_ID),
    );
    const repoBResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_B_ID),
    );
    check('repo A resource exists', repoAResource !== null);
    check('repo B resource exists', repoBResource !== null);
    const repoAId = repoAResource!.id;
    const repoBId = repoBResource!.id;

    const repoAFindings = await findingRepository.findOpenByResource(repoAId);
    const repoACodes = repoAFindings.map((f) => f.ruleCode).sort();
    const expectedRepoACodes = [
      'EMPTY_REPOSITORY',
      'NO_DESCRIPTION',
      'NO_TOPICS',
      'PUBLIC_REPOSITORY',
    ];
    check(
      'repo A has all 4 rule codes open',
      JSON.stringify(repoACodes) === JSON.stringify(expectedRepoACodes),
      JSON.stringify(repoACodes),
    );
    const repoBFindingsRun1 = await findingRepository.findOpenByResource(repoBId);
    check('repo B has 0 open findings after run 1', repoBFindingsRun1.length === 0);

    console.log('2. duplicate prevention — rerunning discovery unchanged creates no new findings');
    const dupeRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', dupeRun.status === 'COMPLETED');
    check(
      'findingsCreated is 0 on unchanged rerun',
      dupeRun.result?.analysis?.findingsCreated === 0,
      JSON.stringify(dupeRun.result?.analysis),
    );
    check(
      'findingsResolved is 0 on unchanged rerun',
      dupeRun.result?.analysis?.findingsResolved === 0,
    );
    const repoAFindingsAfterDupe = await findingRepository.findOpenByResource(repoAId);
    check('repo A still has exactly 4 open findings', repoAFindingsAfterDupe.length === 4);

    console.log(
      '3. finding resolution — fixing repo A resolves its 4 findings; archiving repo B creates 1',
    );
    repoFixtures[0] = {
      ...repoFixtures[0],
      private: true,
      archived: false,
      topics: ['fixed'],
      description: 'Now has a description',
      size: 42,
    };
    repoFixtures[1] = { ...repoFixtures[1], archived: true };

    const secondRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', secondRun.status === 'COMPLETED');
    const secondAnalysis = secondRun.result?.analysis;
    check(
      'findingsResolved is 4',
      secondAnalysis?.findingsResolved === 4,
      JSON.stringify(secondAnalysis),
    );
    check(
      'findingsCreated is 1 (repo B archived)',
      secondAnalysis?.findingsCreated === 1,
      JSON.stringify(secondAnalysis),
    );

    const repoAOpenAfterFix = await findingRepository.findOpenByResource(repoAId);
    check('repo A has 0 open findings after fix', repoAOpenAfterFix.length === 0);
    const repoBOpenAfterArchive = await findingRepository.findOpenByResource(repoBId);
    check(
      'repo B has 1 open finding (ARCHIVED_REPOSITORY)',
      repoBOpenAfterArchive.length === 1 &&
        repoBOpenAfterArchive[0]?.ruleCode === 'ARCHIVED_REPOSITORY',
    );

    console.log('4. recommendation lifecycle — resolved findings resolve their recommendation');
    const repoAAllFindings = await findingRepository.findByResource(repoAId);
    for (const finding of repoAAllFindings) {
      const rec = await recommendationRepository.findByFindingId(finding.id);
      check(
        `recommendation for ${finding.ruleCode} is RESOLVED`,
        rec?.status === 'RESOLVED',
        rec?.status,
      );
    }
    const repoBArchivedFinding = repoBOpenAfterArchive[0];
    const repoBRec = await recommendationRepository.findByFindingId(repoBArchivedFinding.id);
    check('new recommendation for repo B is OPEN', repoBRec?.status === 'OPEN');

    console.log('5. risk calculation — resource/account/asset scores match expected weighted sums');
    const riskAssetRes = await api<{ risk: RiskScoreDto }>(
      'GET',
      `/analysis/risk/assets/${assetId}`,
      ownerToken,
    );
    check('asset risk score is 20 (1 LOW finding)', riskAssetRes.body.risk?.overallScore === 20);
    check('asset risk lowCount is 1', riskAssetRes.body.risk?.lowCount === 1);

    const riskAccountRes = await api<{ risk: RiskScoreDto }>(
      'GET',
      `/analysis/risk/accounts/${accountId}`,
      ownerToken,
    );
    check('account risk score is 20', riskAccountRes.body.risk?.overallScore === 20);

    console.log('6. API endpoints — findings/recommendations list, filter, paginate');
    const findingsListRes = await api<FindingListDto>(
      'GET',
      `/analysis/findings?assetId=${assetId}`,
      ownerToken,
    );
    check('findings list status', findingsListRes.status === 200);
    check(
      'findings list total is 5',
      findingsListRes.body.total === 5,
      `${findingsListRes.body.total}`,
    );

    const openFindingsRes = await api<FindingListDto>(
      'GET',
      `/analysis/findings?assetId=${assetId}&status=OPEN`,
      ownerToken,
    );
    check(
      'open findings filter returns 1',
      openFindingsRes.body.items.length === 1 && openFindingsRes.body.total === 1,
    );

    const oneFinding = openFindingsRes.body.items[0];
    const findingByIdRes = await api<FindingDto>(
      'GET',
      `/analysis/findings/${oneFinding.id}`,
      ownerToken,
    );
    check('finding by id status', findingByIdRes.status === 200);
    check('finding by id matches', findingByIdRes.body.id === oneFinding.id);

    const recsListRes = await api<RecommendationListDto>(
      'GET',
      `/analysis/recommendations?assetId=${assetId}&status=OPEN`,
      ownerToken,
    );
    check('open recommendations is 1', recsListRes.body.items.length === 1);

    console.log('7. authorization — unauthenticated and cross-user access are rejected');
    const noAuth = await api('GET', `/analysis/findings?assetId=${assetId}`, undefined);
    check('unauthenticated status is 401', noAuth.status === 401, `${noAuth.status}`);

    const crossUser = await api('GET', `/analysis/findings/${oneFinding.id}`, other.accessToken);
    check('cross-user finding access is 403', crossUser.status === 403, `${crossUser.status}`);

    const crossUserRisk = await api('GET', `/analysis/risk/assets/${assetId}`, other.accessToken);
    check('cross-user asset risk is 403', crossUserRisk.status === 403, `${crossUserRisk.status}`);

    const nonAdminOverall = await api('GET', '/analysis/risk', ownerToken);
    check('non-admin overall risk (no assetId) is 403', nonAdminOverall.status === 403);

    const adminOverall = await api<{ risk: RiskScoreDto | null }>(
      'GET',
      '/analysis/risk',
      admin.accessToken,
    );
    check('admin overall risk status is 200', adminOverall.status === 200);

    console.log('8. event generation — FINDING_*, RECOMMENDATION_CREATED, RISK_UPDATED fired');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('FINDING_CREATED event exists', eventTypes.includes('FINDING_CREATED'));
    check('FINDING_RESOLVED event exists', eventTypes.includes('FINDING_RESOLVED'));
    check('RECOMMENDATION_CREATED event exists', eventTypes.includes('RECOMMENDATION_CREATED'));
    check('RISK_UPDATED event exists', eventTypes.includes('RISK_UPDATED'));

    if (state.failed) {
      console.error('\nOne or more analysis checks FAILED.');
    } else {
      console.log('\nAll analysis checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    mockServer.close();
    for (const providerResourceId of [String(USER_ID), String(REPO_A_ID), String(REPO_B_ID)]) {
      const row = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (row) {
        const findings = await findingRepository.findByResource(row.id);
        for (const finding of findings) {
          const rec = await recommendationRepository.findByFindingId(finding.id);
          if (rec) {
            await recommendationRepository.delete(rec.id);
          }
          await findingRepository.delete(finding.id);
        }
        await riskScoreRepository.deleteByScope({ scope: 'RESOURCE', resourceId: row.id });
        const outgoing = await relationshipRepository.findByFromResource(row.id);
        const incoming = await relationshipRepository.findByToResource(row.id);
        for (const rel of [...outgoing, ...incoming]) {
          await relationshipRepository.delete(rel.id);
        }
        await resourceRepository.delete(row.id);
      }
    }
    if (accountId) {
      await riskScoreRepository.deleteByScope({ scope: 'ACCOUNT', accountId });
    }
    if (assetId) {
      await riskScoreRepository.deleteByScope({ scope: 'ASSET', assetId });
    }
    console.log('   findings + recommendations + risk scores + resources + relationships deleted');
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
  }

  await prisma.$disconnect();
  process.exit(state.failed ? 1 : 0);
}

void main();
