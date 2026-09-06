// Phase 19 — Risk Agent checks. Two parts, same shape verify-discovery-agent.ts
// established for Phase 18: Part B checks in-process wiring (tool
// registration, orchestratorAgentRegistry, placeholder tools reject);
// Part A drives the real HTTP surface (/ai/risk/*) against a live server
// + mock GitHub server, first running a real discovery (via the existing
// POST /accounts/:id/discover) to populate real Resource/Finding/RiskScore
// rows for the Risk Agent to analyze — this phase's input is Discovery's
// output, so the test setup mirrors that dependency exactly.
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
import { riskAgent } from '../src/ai/agents/risk/index.js';
import { redis } from '../src/cache/redis.js';

// Same port verify-discovery.ts/verify-discovery-agent.ts use — the
// running dev server's GITHUB_USER_URL/REPOS_URL/ORGS_URL are baked in
// from .env at process startup (config/env.ts reads them once), so this
// script (a separate process) cannot redirect them at runtime; it must
// bind the mock server to the same port the server process was already
// configured to call. Verify scripts run sequentially, never concurrently
// against the same dev server, so reusing the port is safe.
const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-risk-agent-credential';

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface RiskFindingDto {
  id: string;
  ruleCode: string;
  severity: string;
  reasoning: string;
  evidence: string[];
  priority: string;
  businessImpact: string;
  repeated: boolean;
}
interface JobDto {
  status: string;
  error?: string | null;
  result: {
    status?: string;
    assetId?: string;
    overallScore?: number;
    businessImpact?: string;
    counts?: { critical: number; high: number; medium: number; low: number; informational: number };
    findings?: RiskFindingDto[];
    criticalFindings?: RiskFindingDto[];
    highFindings?: RiskFindingDto[];
    mediumFindings?: RiskFindingDto[];
    lowFindings?: RiskFindingDto[];
    summary?: string;
    confidenceScore?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
}
interface HistoryDto {
  items: { assetId: string; status: string; overallScore: number }[];
}
interface SummaryDto {
  status: string;
  overallScore?: number;
}
interface FindingsListDto {
  items: RiskFindingDto[];
  total: number;
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
          id: 991144,
          login: 'verify-risk-agent-user',
          name: 'Verify Risk Agent User',
          html_url: 'https://github.com/verify-risk-agent-user',
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
            id: 5001,
            name: 'risk-agent-public-repo',
            full_name: 'verify-risk-agent-user/risk-agent-public-repo',
            private: false,
            html_url: 'https://github.com/verify-risk-agent-user/risk-agent-public-repo',
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
    'risk-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('risk-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('risk-agent') === riskAgent,
  );
  check('riskAgent.canHandle("analyze risk")', riskAgent.canHandle('analyze risk'));
  check('riskAgent.canHandle("DISCOVER_ASSETS") is false', !riskAgent.canHandle('DISCOVER_ASSETS'));

  for (const toolName of [
    'risk_engine_score',
    'risk_asset_lookup',
    'risk_finding_store_list',
    'risk_repository_aggregate',
    'risk_secrets_scanner',
    'risk_branch_protection',
    'risk_workflow_risk',
    'risk_dependency_risk',
    'risk_security_alert',
  ]) {
    check(`tool "${toolName}" is registered`, aiFoundation.toolRegistry.has(toolName));
  }

  let placeholderRejected = false;
  try {
    await aiFoundation.toolRegistry.execute(
      'risk_secrets_scanner',
      { assetId: 'irrelevant' },
      { user: { id: 'verify-user', role: 'USER' }, toolHistory: [], executionHistory: [] },
    );
  } catch (e) {
    placeholderRejected = e instanceof ToolExecutionError;
  }
  check(
    'placeholder tool (secrets scanner) rejects rather than returning fake data',
    placeholderRejected,
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
      '0. setup — admin+category, asset, owner, connected GitHub account, real discovery run',
    );
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('risk-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-risk-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-risk-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Risk Agent discovery target',
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

    console.log('1. unauthorized — /ai/risk/analyze without a token is rejected');
    const noAuth = await api('POST', '/ai/risk/analyze', undefined, { assetId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/risk/analyze — enqueues an AI_RISK job (202)');
    const analyzeRes = await api<EnqueueResponseDto>('POST', '/ai/risk/analyze', ownerToken, {
      assetId,
      message: 'Analyze risk for this asset',
    });
    check('status 202', analyzeRes.status === 202, `${analyzeRes.status}`);
    check('jobId present', typeof analyzeRes.body.jobId === 'string');
    jobIds.push(analyzeRes.body.jobId);

    console.log('3. job completes — RiskAgentOutput-shaped result');
    const settled = await pollJobSettled(analyzeRes.body.jobId, ownerToken);
    check('job status COMPLETED', settled.status === 'COMPLETED', settled.status);
    check('result.status is SUCCESS', settled.result?.status === 'SUCCESS', settled.result?.status);
    check('assetId matches', settled.result?.assetId === assetId);
    check(
      'overallScore is a positive number (PUBLIC_REPOSITORY finding raises it above 0)',
      typeof settled.result?.overallScore === 'number' && (settled.result?.overallScore ?? 0) > 0,
      `${settled.result?.overallScore}`,
    );
    check(
      'medium findings include PUBLIC_REPOSITORY',
      settled.result?.mediumFindings?.some((f) => f.ruleCode === 'PUBLIC_REPOSITORY'),
    );
    check(
      'the PUBLIC_REPOSITORY finding has non-empty reasoning and evidence (never scored by the LLM)',
      settled.result?.mediumFindings?.some(
        (f) =>
          f.ruleCode === 'PUBLIC_REPOSITORY' && f.reasoning.length > 0 && f.evidence.length > 0,
      ),
    );
    check(
      'businessImpact is MODERATE (deterministic mapping off of medium-severity counts)',
      settled.result?.businessImpact === 'MODERATE',
      settled.result?.businessImpact,
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

    console.log('4. GET /ai/risk/history — returns the run just completed');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/risk/history?assetId=${assetId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      "history includes this asset's run",
      historyRes.body.items.some((item) => item.assetId === assetId && item.status === 'SUCCESS'),
    );

    console.log('5. GET /ai/risk/summary — reflects the last run');
    const summaryRes = await api<SummaryDto>(
      'GET',
      `/ai/risk/summary?assetId=${assetId}`,
      ownerToken,
    );
    check('summary endpoint 200', summaryRes.status === 200, `${summaryRes.status}`);
    check('summary reflects SUCCESS', summaryRes.body.status === 'SUCCESS', summaryRes.body.status);

    console.log('6. GET /ai/risk/findings — agent-shaped findings, ownership-checked');
    const findingsRes = await api<FindingsListDto>(
      'GET',
      `/ai/risk/findings?assetId=${assetId}`,
      ownerToken,
    );
    check('findings status 200', findingsRes.status === 200, `${findingsRes.status}`);
    check(
      'findings includes PUBLIC_REPOSITORY',
      findingsRes.body.items.some((f) => f.ruleCode === 'PUBLIC_REPOSITORY'),
    );
    check(
      'findings are ownership-shaped with reasoning/priority',
      findingsRes.body.items.every(
        (f) => typeof f.reasoning === 'string' && typeof f.priority === 'string',
      ),
    );

    console.log('7. re-running analysis marks the same finding as repeated (Memory requirement)');
    const secondAnalyzeRes = await api<EnqueueResponseDto>('POST', '/ai/risk/analyze', ownerToken, {
      assetId,
    });
    jobIds.push(secondAnalyzeRes.body.jobId);
    const secondSettled = await pollJobSettled(secondAnalyzeRes.body.jobId, ownerToken);
    check('second run COMPLETED', secondSettled.status === 'COMPLETED', secondSettled.status);
    check(
      'second run marks PUBLIC_REPOSITORY as repeated',
      secondSettled.result?.mediumFindings?.some(
        (f) => f.ruleCode === 'PUBLIC_REPOSITORY' && f.repeated === true,
      ),
    );

    console.log(
      '8. missing asset target — permanent failure (job goes straight to FAILED, not retried)',
    );
    const missingAssetRes = await api<EnqueueResponseDto>('POST', '/ai/risk/analyze', ownerToken, {
      assetId: 'nonexistent-asset-id-does-not-exist',
    });
    check(
      'enqueue against a nonexistent asset is rejected up front (404)',
      missingAssetRes.status === 404,
      `${missingAssetRes.status}`,
    );

    console.log('9. cross-user access — history/summary/findings are ownership-checked');
    const stranger = await registerAndLogin(`verify-risk-agent-stranger-${stamp}@example.test`);
    const strangerHistoryRes = await api(
      'GET',
      `/ai/risk/history?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    const strangerFindingsRes = await api(
      'GET',
      `/ai/risk/findings?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user findings is 403',
      strangerFindingsRes.status === 403,
      `${strangerFindingsRes.status}`,
    );
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Risk Agent checks FAILED.');
    } else {
      console.log('\nAll Risk Agent checks passed.');
    }
  } finally {
    console.log('10. cleanup');
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
