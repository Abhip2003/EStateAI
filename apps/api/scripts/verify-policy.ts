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
import { policyRepository } from '../src/repositories/policy.repository.js';
import { policyResultRepository } from '../src/repositories/policy-result.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'policy-credential-good';
const USER_ID = 660055;
const REPO_A_ID = 8301; // broken: public, no description, no topics
const REPO_B_ID = 8302; // clean but archived
const REPO_C_ID = 8303; // clean fork

interface RepoFixture {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  topics: string[];
  size: number;
  fork: boolean;
}

const repoFixtures: RepoFixture[] = [
  {
    id: REPO_A_ID,
    name: 'broken-repo',
    description: null,
    private: false,
    archived: false,
    topics: [],
    size: 10,
    fork: false,
  },
  {
    id: REPO_B_ID,
    name: 'archived-repo',
    description: 'A clean, archived repo',
    private: true,
    archived: true,
    topics: ['ok'],
    size: 10,
    fork: false,
  },
  {
    id: REPO_C_ID,
    name: 'forked-repo',
    description: 'A clean fork',
    private: true,
    archived: false,
    topics: ['ok'],
    size: 10,
    fork: true,
  },
];

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface PolicySummaryDto {
  policiesExecuted: number;
  resourcesEvaluated: number;
  passed: number;
  failed: number;
  warned: number;
  notApplicable: number;
  durationMs: number;
}

interface JobDto {
  status: string;
  result: { success?: boolean; policy?: PolicySummaryDto } | null;
}

interface PolicyDto {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
}

interface PolicyListDto {
  items: PolicyDto[];
  total: number;
}

interface ComplianceReportDto {
  scope: string;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  complianceScore: number;
  policyFailures: { policyCode: string; resourceId: string }[];
  policyPasses: { policyCode: string; resourceId: string }[];
  severityDistribution: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    informational: number;
  };
  riskDistribution: { low: number; medium: number; high: number; critical: number };
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
          login: 'verify-policy-user',
          name: 'Verify Policy User',
          html_url: 'https://github.com/verify-policy-user',
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
            full_name: `verify-policy-user/${repo.name}`,
            description: repo.description,
            private: repo.private,
            html_url: `https://github.com/verify-policy-user/${repo.name}`,
            language: 'TypeScript',
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
            archived: repo.archived,
            topics: repo.topics,
            size: repo.size,
            fork: repo.fork,
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
  let disabledPolicyId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner + another user, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('policy');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-policy-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-policy-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-policy-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Policy target',
    });
    accountId = connectRes.body.id;

    console.log('1. policy evaluation — 3 repos through 5 policies each');
    const firstRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', firstRun.status === 'COMPLETED', firstRun.status);
    const firstPolicy = firstRun.result?.policy;
    check(
      'policiesExecuted is 15 (3 repos x 5 policies)',
      firstPolicy?.policiesExecuted === 15,
      JSON.stringify(firstPolicy),
    );
    check('passed is 8', firstPolicy?.passed === 8, JSON.stringify(firstPolicy));
    check('failed is 3', firstPolicy?.failed === 3, JSON.stringify(firstPolicy));
    check('warned is 1', firstPolicy?.warned === 1, JSON.stringify(firstPolicy));
    check('notApplicable is 3', firstPolicy?.notApplicable === 3, JSON.stringify(firstPolicy));

    const repoAResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_A_ID),
    );
    const repoBResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_B_ID),
    );
    const repoCResource = await resourceRepository.findByProviderAndProviderResourceId(
      'github',
      String(REPO_C_ID),
    );
    check('repo A resource exists', repoAResource !== null);
    check('repo B resource exists', repoBResource !== null);
    check('repo C resource exists', repoCResource !== null);
    const repoAId = repoAResource!.id;
    const repoBId = repoBResource!.id;
    const repoCId = repoCResource!.id;

    const repoAResults = await policyResultRepository.findByResource(repoAId);
    check('repo A has 5 policy results', repoAResults.length === 5, `${repoAResults.length}`);
    const repoAFailCodes = new Set(
      repoAResults.filter((r) => r.status === 'FAIL').map((r) => r.policyId),
    );
    check('repo A has exactly 3 FAIL results', repoAFailCodes.size === 3);

    const repoBResults = await policyResultRepository.findByResource(repoBId);
    check(
      'repo B has 1 WARNING (archived) and 4 PASS',
      repoBResults.filter((r) => r.status === 'WARNING').length === 1 &&
        repoBResults.filter((r) => r.status === 'PASS').length === 4,
    );

    const repoCResults = await policyResultRepository.findByResource(repoCId);
    check(
      'repo C has 2 NOT_APPLICABLE (fork + not archived) and 3 PASS',
      repoCResults.filter((r) => r.status === 'NOT_APPLICABLE').length === 2 &&
        repoCResults.filter((r) => r.status === 'PASS').length === 3,
    );

    console.log('2. policy registry — GET /policies lists all 5 registered policies');
    const policiesRes = await api<PolicyListDto>('GET', '/policies?limit=50', ownerToken);
    check('policies list status', policiesRes.status === 200);
    const expectedCodes = [
      'NO_PUBLIC_REPOSITORIES',
      'REPOSITORIES_MUST_HAVE_DESCRIPTION',
      'REPOSITORIES_MUST_HAVE_TOPICS',
      'ARCHIVED_REPOSITORIES_ARE_ALLOWED',
      'FORK_REPOSITORIES_IGNORED',
    ];
    const listedCodes = policiesRes.body.items.map((p) => p.code);
    check(
      'all 5 expected policy codes are listed',
      expectedCodes.every((code) => listedCodes.includes(code)),
      listedCodes.join(','),
    );

    const noPublicPolicy = policiesRes.body.items.find((p) => p.code === 'NO_PUBLIC_REPOSITORIES');
    check('NO_PUBLIC_REPOSITORIES policy found', noPublicPolicy !== undefined);
    check('NO_PUBLIC_REPOSITORIES is enabled by default', noPublicPolicy?.enabled === true);

    const policyByIdRes = await api<PolicyDto>(
      'GET',
      `/policies/${noPublicPolicy!.id}`,
      ownerToken,
    );
    check('policy by id status', policyByIdRes.status === 200);
    check('policy by id matches', policyByIdRes.body.id === noPublicPolicy!.id);

    console.log('3. compliance score — asset and account reports match expected weighted totals');
    const assetComplianceRes = await api<ComplianceReportDto>(
      'GET',
      `/compliance/assets/${assetId}`,
      ownerToken,
    );
    check('asset compliance status', assetComplianceRes.status === 200);
    check(
      'asset complianceScore is 71',
      assetComplianceRes.body.complianceScore === 71,
      `${assetComplianceRes.body.complianceScore}`,
    );
    check('asset passCount is 8', assetComplianceRes.body.passCount === 8);
    check('asset failCount is 3', assetComplianceRes.body.failCount === 3);
    check('asset warningCount is 1', assetComplianceRes.body.warningCount === 1);
    check('asset notApplicableCount is 3', assetComplianceRes.body.notApplicableCount === 3);
    check(
      'asset policyFailures has 3 entries',
      assetComplianceRes.body.policyFailures.length === 3,
    );
    check('asset policyPasses has 8 entries', assetComplianceRes.body.policyPasses.length === 8);
    check(
      'severityDistribution: 1 medium, 1 low, 2 informational',
      assetComplianceRes.body.severityDistribution.medium === 1 &&
        assetComplianceRes.body.severityDistribution.low === 1 &&
        assetComplianceRes.body.severityDistribution.informational === 2,
      JSON.stringify(assetComplianceRes.body.severityDistribution),
    );
    check(
      // 3 low (repo B, repo C, plus the "user" resource which has no
      // findings) + 1 high (repo A) — RiskService computes a RESOURCE-scope
      // RiskScore for every persisted resource, not just repositories.
      'riskDistribution: 3 low, 1 high',
      assetComplianceRes.body.riskDistribution.low === 3 &&
        assetComplianceRes.body.riskDistribution.high === 1,
      JSON.stringify(assetComplianceRes.body.riskDistribution),
    );

    const accountComplianceRes = await api<ComplianceReportDto>(
      'GET',
      `/compliance/accounts/${accountId}`,
      ownerToken,
    );
    check('account compliance status', accountComplianceRes.status === 200);
    check('account complianceScore is 71', accountComplianceRes.body.complianceScore === 71);

    console.log(
      '4. duplicate prevention — rerunning discovery unchanged does not duplicate results',
    );
    const eventsBeforeRerun = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const policyEventCountBefore = eventsBeforeRerun.body.items.filter(
      (e) => e.type === 'POLICY_PASSED' || e.type === 'POLICY_FAILED',
    ).length;

    const secondRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', secondRun.status === 'COMPLETED');
    check(
      'policiesExecuted still 15 on unchanged rerun',
      secondRun.result?.policy?.policiesExecuted === 15,
    );

    const repoAResultsAfterRerun = await policyResultRepository.findByResource(repoAId);
    check(
      'repo A still has exactly 5 policy results (no duplicates)',
      repoAResultsAfterRerun.length === 5,
    );

    const eventsAfterRerun = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const policyEventCountAfter = eventsAfterRerun.body.items.filter(
      (e) => e.type === 'POLICY_PASSED' || e.type === 'POLICY_FAILED',
    ).length;
    check(
      'no new POLICY_PASSED/POLICY_FAILED events on unchanged rerun',
      policyEventCountAfter === policyEventCountBefore,
      `${policyEventCountBefore} -> ${policyEventCountAfter}`,
    );

    console.log('5. policy updates — disabling a policy excludes it from the next evaluation run');
    disabledPolicyId = noPublicPolicy!.id;
    await policyRepository.update(disabledPolicyId, { enabled: false });

    const disabledListRes = await api<PolicyListDto>(
      'GET',
      '/policies?enabled=false&limit=50',
      ownerToken,
    );
    check(
      'disabled policy appears in enabled=false filter',
      disabledListRes.body.items.some((p) => p.id === disabledPolicyId),
    );

    const thirdRun = await runDiscovery(accountId, ownerToken);
    check('job status is COMPLETED', thirdRun.status === 'COMPLETED');
    check(
      'policiesExecuted drops to 12 (4 policies x 3 repos) once disabled',
      thirdRun.result?.policy?.policiesExecuted === 12,
      JSON.stringify(thirdRun.result?.policy),
    );

    await policyRepository.update(disabledPolicyId, { enabled: true });
    const reenabledRun = await runDiscovery(accountId, ownerToken);
    check(
      're-enabled policy restores policiesExecuted to 15',
      reenabledRun.result?.policy?.policiesExecuted === 15,
    );
    disabledPolicyId = undefined;

    console.log('6. authorization — unauthenticated and cross-user access are rejected');
    const noAuth = await api('GET', '/policies', undefined);
    check('unauthenticated status is 401', noAuth.status === 401, `${noAuth.status}`);

    const crossUserAsset = await api('GET', `/compliance/assets/${assetId}`, other.accessToken);
    check('cross-user asset compliance is 403', crossUserAsset.status === 403);

    const crossUserAccount = await api(
      'GET',
      `/compliance/accounts/${accountId}`,
      other.accessToken,
    );
    check('cross-user account compliance is 403', crossUserAccount.status === 403);

    const nonAdminOverview = await api('GET', '/compliance', ownerToken);
    check('non-admin overview (no assetId) is 403', nonAdminOverview.status === 403);

    const adminOverview = await api<ComplianceReportDto>('GET', '/compliance', admin.accessToken);
    check('admin overview status is 200', adminOverview.status === 200);

    const nonAdminProvider = await api('GET', '/compliance?provider=github', ownerToken);
    check('non-admin provider compliance is 403', nonAdminProvider.status === 403);

    const adminProvider = await api<ComplianceReportDto>(
      'GET',
      '/compliance?provider=github',
      admin.accessToken,
    );
    check('admin provider compliance status is 200', adminProvider.status === 200);

    console.log('7. reports — policyFailures/policyPasses reference the right resources');
    check(
      'policyFailures all reference repo A',
      assetComplianceRes.body.policyFailures.every((f) => f.resourceId === repoAId),
    );
    check(
      'policyPasses include repo B and repo C',
      assetComplianceRes.body.policyPasses.some((p) => p.resourceId === repoBId) &&
        assetComplianceRes.body.policyPasses.some((p) => p.resourceId === repoCId),
    );

    console.log('8. event generation — POLICY_PASSED, POLICY_FAILED, COMPLIANCE_UPDATED fired');
    const finalEventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = finalEventsRes.body.items.map((e) => e.type);
    check('POLICY_PASSED event exists', eventTypes.includes('POLICY_PASSED'));
    check('POLICY_FAILED event exists', eventTypes.includes('POLICY_FAILED'));
    check('COMPLIANCE_UPDATED event exists', eventTypes.includes('COMPLIANCE_UPDATED'));

    if (state.failed) {
      console.error('\nOne or more policy checks FAILED.');
    } else {
      console.log('\nAll policy checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    mockServer.close();
    if (disabledPolicyId) {
      await policyRepository.update(disabledPolicyId, { enabled: true });
    }
    for (const providerResourceId of [
      String(USER_ID),
      String(REPO_A_ID),
      String(REPO_B_ID),
      String(REPO_C_ID),
    ]) {
      const row = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (row) {
        const policyResults = await policyResultRepository.findByResource(row.id);
        for (const result of policyResults) {
          await policyResultRepository.delete(result.id);
        }
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
    console.log('   policy results + findings + risk scores + resources + relationships deleted');
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
