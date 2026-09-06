// Phase 20 — Compliance Agent checks. Two parts, same shape verify-risk-agent.ts
// established for Phase 19: Part B checks in-process wiring (tool
// registration, orchestratorAgentRegistry, framework registry); Part A
// drives the real HTTP surface (/ai/compliance/*) against a live server +
// mock GitHub server, first running a real discovery (via the existing
// POST /accounts/:id/discover) against a public, undocumented,
// topic-less repository so several existing GitHub policies fail —
// populating real PolicyResult rows for the Compliance Agent to assess.
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
import { complianceAgent } from '../src/ai/agents/compliance/index.js';
import { listFrameworks } from '../src/ai/agents/compliance/compliance.mapping.js';
import { redis } from '../src/cache/redis.js';

// Same port verify-discovery.ts/verify-discovery-agent.ts/verify-risk-agent.ts
// use — the running dev server's GITHUB_USER_URL/REPOS_URL/ORGS_URL are
// baked in from .env at process startup, so this script (a separate
// process) cannot redirect them at runtime; it must bind the mock server
// to the same port the server process was already configured to call.
// Verify scripts run sequentially, never concurrently, so reusing the
// port is safe.
const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-compliance-agent-credential';

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface ComplianceControlDto {
  framework: string;
  controlId: string;
  status: string;
  policyCode?: string;
  reasoning: string;
  evidence: string[];
}
interface ComplianceFrameworkDto {
  framework: string;
  name: string;
  passedControls: ComplianceControlDto[];
  failedControls: ComplianceControlDto[];
  missingControls: ComplianceControlDto[];
  coveragePercent: number;
}
interface JobDto {
  status: string;
  error?: string | null;
  result: {
    status?: string;
    assetId?: string;
    complianceScore?: number;
    passCount?: number;
    failCount?: number;
    frameworks?: ComplianceFrameworkDto[];
    summary?: string;
    confidenceScore?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
}
interface HistoryDto {
  items: { assetId: string; status: string; complianceScore: number }[];
}
interface SummaryDto {
  status: string;
  complianceScore?: number;
}
interface FrameworksDto {
  items: { framework: string; name: string; controlCount: number; mappedPolicyCodes: string[] }[];
}

async function pollJobSettled(jobId: string, token: string, timeoutMs = 15_000): Promise<JobDto> {
  const deadline = Date.now() + timeoutMs;
  let last: JobDto;
  do {
    const res = await api<JobDto>('GET', `/jobs/${jobId}`, token);
    last = res.body;
    if (last.status !== 'QUEUED' && last.status !== 'RUNNING' && last.status !== 'RETRYING') {
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
          id: 992255,
          login: 'verify-compliance-agent-user',
          name: 'Verify Compliance Agent User',
          html_url: 'https://github.com/verify-compliance-agent-user',
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
            id: 6001,
            name: 'compliance-agent-noncompliant-repo',
            full_name: 'verify-compliance-agent-user/compliance-agent-noncompliant-repo',
            private: false,
            html_url:
              'https://github.com/verify-compliance-agent-user/compliance-agent-noncompliant-repo',
            description: null,
            language: 'TypeScript',
            topics: [],
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
      res.end(JSON.stringify([]));
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
    'compliance-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('compliance-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('compliance-agent') === complianceAgent,
  );
  check(
    'complianceAgent.canHandle("assess compliance")',
    complianceAgent.canHandle('assess compliance'),
  );
  check(
    'complianceAgent.canHandle("DISCOVER_ASSETS") is false',
    !complianceAgent.canHandle('DISCOVER_ASSETS'),
  );

  for (const toolName of [
    'compliance_engine_evaluate',
    'compliance_policy_lookup',
    'compliance_finding_lookup',
    'compliance_asset_lookup',
    'compliance_framework_mapping',
    'compliance_control_coverage',
    'compliance_evidence',
    'compliance_store',
  ]) {
    check(`tool "${toolName}" is registered`, aiFoundation.toolRegistry.has(toolName));
  }

  const frameworks = listFrameworks();
  check('framework registry lists 4 frameworks', frameworks.length === 4);
  check(
    'every framework has a positive control count',
    frameworks.every((f) => f.controlCount > 0),
  );
  check(
    'every framework has at least one mapped policy code',
    frameworks.every((f) => f.mappedPolicyCodes.length > 0),
  );

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
    console.log(
      '0. setup — admin+category, asset, owner, connected GitHub account, real discovery run against a non-compliant repo',
    );
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('compliance-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-compliance-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-compliance-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Compliance Agent discovery target',
    });
    const accountId = connectRes.body.id;
    accountIds.push(accountId);

    const discoverRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    check(
      'setup discovery enqueue succeeded (202)',
      discoverRes.status === 202,
      `${discoverRes.status}`,
    );
    jobIds.push(discoverRes.body.jobId);
    const discoverSettled = await pollJobSettled(discoverRes.body.jobId, ownerToken);
    check(
      'setup discovery job COMPLETED',
      discoverSettled.status === 'COMPLETED',
      discoverSettled.status,
    );

    console.log('1. unauthorized — /ai/compliance/analyze without a token is rejected');
    const noAuth = await api('POST', '/ai/compliance/analyze', undefined, { assetId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/compliance/analyze — enqueues an AI_COMPLIANCE job (202)');
    const analyzeRes = await api<EnqueueResponseDto>('POST', '/ai/compliance/analyze', ownerToken, {
      assetId,
      message: 'Assess compliance for this asset',
    });
    check('status 202', analyzeRes.status === 202, `${analyzeRes.status}`);
    check('jobId present', typeof analyzeRes.body.jobId === 'string');
    jobIds.push(analyzeRes.body.jobId);

    console.log('3. job completes — ComplianceAgentOutput-shaped result');
    const settled = await pollJobSettled(analyzeRes.body.jobId, ownerToken);
    check('job status COMPLETED', settled.status === 'COMPLETED', settled.status);
    check('result.status is SUCCESS', settled.result?.status === 'SUCCESS', settled.result?.status);
    check('assetId matches', settled.result?.assetId === assetId);
    check(
      'complianceScore is a number between 0 and 100',
      typeof settled.result?.complianceScore === 'number' &&
        settled.result.complianceScore >= 0 &&
        settled.result.complianceScore <= 100,
      `${settled.result?.complianceScore}`,
    );
    check(
      'failCount is positive (public/undocumented/topic-less repo fails multiple policies)',
      (settled.result?.failCount ?? 0) > 0,
      `${settled.result?.failCount}`,
    );
    check('frameworks.length is 4', settled.result?.frameworks?.length === 4);

    const nistResult = settled.result?.frameworks?.find((f) => f.framework === 'NIST_CSF');
    check('NIST_CSF framework result present', !!nistResult);
    check(
      'NIST_CSF has at least one failed control mapped to NO_PUBLIC_REPOSITORIES',
      !!nistResult?.failedControls.some((c) => c.policyCode === 'NO_PUBLIC_REPOSITORIES'),
    );
    check(
      'failed control has non-empty reasoning and evidence (never scored by the LLM)',
      !!nistResult?.failedControls.some((c) => c.reasoning.length > 0 && c.evidence.length > 0),
    );
    check(
      'at least one framework has missing (unmapped) controls',
      !!settled.result?.frameworks?.some((f) => f.missingControls.length > 0),
    );
    check(
      'coveragePercent is a valid percentage on every framework',
      !!settled.result?.frameworks?.every(
        (f) => f.coveragePercent >= 0 && f.coveragePercent <= 100,
      ),
    );
    check(
      'summary is a non-empty string',
      typeof settled.result?.summary === 'string' && (settled.result?.summary.length ?? 0) > 0,
    );
    check(
      'confidenceScore is 1 for a clean success',
      settled.result?.confidenceScore === 1,
      `${settled.result?.confidenceScore}`,
    );
    check('no errors on a clean run', (settled.result?.errors?.length ?? -1) === 0);

    console.log('4. GET /ai/compliance/history — returns the run just completed');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/compliance/history?assetId=${assetId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      "history includes this asset's run",
      historyRes.body.items.some((item) => item.assetId === assetId && item.status === 'SUCCESS'),
    );

    console.log('5. GET /ai/compliance/summary — reflects the last run');
    const summaryRes = await api<SummaryDto>(
      'GET',
      `/ai/compliance/summary?assetId=${assetId}`,
      ownerToken,
    );
    check('summary endpoint 200', summaryRes.status === 200, `${summaryRes.status}`);
    check('summary reflects SUCCESS', summaryRes.body.status === 'SUCCESS', summaryRes.body.status);

    console.log('6. GET /ai/compliance/frameworks — introspection, no ownership scope');
    const frameworksRes = await api<FrameworksDto>('GET', '/ai/compliance/frameworks', ownerToken);
    check('frameworks status 200', frameworksRes.status === 200, `${frameworksRes.status}`);
    check('frameworks lists 4 items', frameworksRes.body.items.length === 4);
    check(
      'CIS_CONTROLS is listed',
      frameworksRes.body.items.some((f) => f.framework === 'CIS_CONTROLS'),
    );

    console.log(
      '7. missing asset target — enqueue against a nonexistent asset is rejected up front (404)',
    );
    const missingAssetRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/compliance/analyze',
      ownerToken,
      { assetId: 'nonexistent-asset-id-does-not-exist' },
    );
    check('nonexistent asset is 404', missingAssetRes.status === 404, `${missingAssetRes.status}`);

    console.log('8. cross-user access — history/summary are ownership-checked');
    const stranger = await registerAndLogin(
      `verify-compliance-agent-stranger-${stamp}@example.test`,
    );
    const strangerHistoryRes = await api(
      'GET',
      `/ai/compliance/history?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    const strangerSummaryRes = await api(
      'GET',
      `/ai/compliance/summary?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user summary is 403',
      strangerSummaryRes.status === 403,
      `${strangerSummaryRes.status}`,
    );
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Compliance Agent checks FAILED.');
    } else {
      console.log('\nAll Compliance Agent checks passed.');
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
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
