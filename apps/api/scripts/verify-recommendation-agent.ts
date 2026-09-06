// Phase 20 — Recommendation Agent checks. Same two-part shape as
// verify-compliance-agent.ts: Part B checks in-process wiring; Part A
// drives the real HTTP surface against a live server + mock GitHub
// server. The AI_RECOMMENDATION job dispatcher path calls
// RecommendationAgent standalone (no live OrchestrationContext handoff
// from a sibling Risk Agent step), so this is exactly what exercises the
// 'fallback' handoff-source path (recommendation.aggregate.ts) — the
// live-context 'context' path is covered by verify-multi-agent-
// collaboration.ts instead, which runs a real orchestrator workflow.
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
import { recommendationAgent } from '../src/ai/agents/recommendation/index.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-recommendation-agent-credential';

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface RecommendationViewDto {
  id: string;
  title: string;
  priority: string;
  sourceAgents: string[];
  sourceFindingIds: string[];
  confidence: number;
  reasoning: string;
}
interface JobDto {
  status: string;
  error?: string | null;
  result: {
    status?: string;
    assetId?: string;
    recommendations?: RecommendationViewDto[];
    prioritized?: RecommendationViewDto[];
    handoffSources?: { agentId: string; used: boolean; origin: string }[];
    summary?: string;
    confidenceScore?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
}
interface HistoryDto {
  items: { assetId: string; status: string; recommendationCount: number }[];
}
interface SummaryDto {
  status: string;
  recommendationCount?: number;
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
          id: 992266,
          login: 'verify-recommendation-agent-user',
          name: 'Verify Recommendation Agent User',
          html_url: 'https://github.com/verify-recommendation-agent-user',
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
            id: 7001,
            name: 'recommendation-agent-noncompliant-repo',
            full_name: 'verify-recommendation-agent-user/recommendation-agent-noncompliant-repo',
            private: false,
            html_url:
              'https://github.com/verify-recommendation-agent-user/recommendation-agent-noncompliant-repo',
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
    'recommendation-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('recommendation-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('recommendation-agent') === recommendationAgent,
  );
  check(
    'recommendationAgent.canHandle("recommend fixes")',
    recommendationAgent.canHandle('recommend fixes'),
  );
  check(
    'recommendationAgent.canHandle("DISCOVER_ASSETS") is false',
    !recommendationAgent.canHandle('DISCOVER_ASSETS'),
  );

  for (const toolName of [
    'recommendation_engine_list',
    'recommendation_finding_lookup',
    'recommendation_asset_lookup',
  ]) {
    check(`tool "${toolName}" is registered`, aiFoundation.toolRegistry.has(toolName));
  }

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
      '0. setup — admin+category, asset, owner, connected GitHub account, real discovery run (populates Finding + Recommendation rows)',
    );
    const { admin, categoryId: newCategoryId } =
      await createAdminAndCategory('recommendation-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-recommendation-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-recommendation-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Recommendation Agent discovery target',
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

    console.log('1. unauthorized — /ai/recommendation/analyze without a token is rejected');
    const noAuth = await api('POST', '/ai/recommendation/analyze', undefined, { assetId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/recommendation/analyze — enqueues an AI_RECOMMENDATION job (202)');
    const analyzeRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/recommendation/analyze',
      ownerToken,
      { assetId, message: 'What should we fix first?' },
    );
    check('status 202', analyzeRes.status === 202, `${analyzeRes.status}`);
    check('jobId present', typeof analyzeRes.body.jobId === 'string');
    jobIds.push(analyzeRes.body.jobId);

    console.log(
      '3. job completes — RecommendationAgentOutput-shaped result, standalone (fallback) handoff',
    );
    const settled = await pollJobSettled(analyzeRes.body.jobId, ownerToken);
    check('job status COMPLETED', settled.status === 'COMPLETED', settled.status);
    check(
      'result.status is SUCCESS or PARTIAL',
      settled.result?.status === 'SUCCESS' || settled.result?.status === 'PARTIAL',
      settled.result?.status,
    );
    check('assetId matches', settled.result?.assetId === assetId);
    check(
      'recommendations is a non-empty array (public/undocumented/topic-less repo has open findings)',
      (settled.result?.recommendations?.length ?? 0) > 0,
      `${settled.result?.recommendations?.length}`,
    );
    check(
      'every recommendation has a resolved sourceFindingId (fallback finding lookup matched)',
      !!settled.result?.recommendations?.every((r) => r.sourceFindingIds.length > 0),
    );
    check(
      'every recommendation has confidence in [0,100]',
      !!settled.result?.recommendations?.every((r) => r.confidence >= 0 && r.confidence <= 100),
    );
    check(
      'prioritized is sorted by priority rank (non-increasing)',
      (() => {
        const rank: Record<string, number> = {
          CRITICAL: 5,
          HIGH: 4,
          MEDIUM: 3,
          LOW: 2,
          INFORMATIONAL: 1,
        };
        const list = settled.result?.prioritized ?? [];
        return list.every((r, i) => i === 0 || rank[list[i - 1].priority] >= rank[r.priority]);
      })(),
    );
    check(
      'handoffSources reports risk-agent used via fallback origin (no live workflow ran Risk Agent)',
      !!settled.result?.handoffSources?.some(
        (s) => s.agentId === 'risk-agent' && s.used === true && s.origin === 'fallback',
      ),
      JSON.stringify(settled.result?.handoffSources),
    );
    check(
      'handoffSources reports compliance-agent as unavailable (no live workflow ran Compliance Agent)',
      !!settled.result?.handoffSources?.some(
        (s) => s.agentId === 'compliance-agent' && s.used === false && s.origin === 'unavailable',
      ),
      JSON.stringify(settled.result?.handoffSources),
    );
    check(
      'summary is a non-empty string',
      typeof settled.result?.summary === 'string' && (settled.result?.summary.length ?? 0) > 0,
    );
    check('no errors on a clean run', (settled.result?.errors?.length ?? -1) === 0);

    console.log('4. GET /ai/recommendation/history — returns the run just completed');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/recommendation/history?assetId=${assetId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      "history includes this asset's run",
      historyRes.body.items.some((item) => item.assetId === assetId),
    );

    console.log('5. GET /ai/recommendation/summary — reflects the last run');
    const summaryRes = await api<SummaryDto>(
      'GET',
      `/ai/recommendation/summary?assetId=${assetId}`,
      ownerToken,
    );
    check('summary endpoint 200', summaryRes.status === 200, `${summaryRes.status}`);
    check(
      'summary reflects a positive recommendation count',
      (summaryRes.body.recommendationCount ?? 0) > 0,
      `${summaryRes.body.recommendationCount}`,
    );

    console.log(
      '6. missing asset target — enqueue against a nonexistent asset is rejected up front (404)',
    );
    const missingAssetRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/recommendation/analyze',
      ownerToken,
      { assetId: 'nonexistent-asset-id-does-not-exist' },
    );
    check('nonexistent asset is 404', missingAssetRes.status === 404, `${missingAssetRes.status}`);

    console.log('7. cross-user access — history/summary are ownership-checked');
    const stranger = await registerAndLogin(
      `verify-recommendation-agent-stranger-${stamp}@example.test`,
    );
    const strangerHistoryRes = await api(
      'GET',
      `/ai/recommendation/history?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    const strangerSummaryRes = await api(
      'GET',
      `/ai/recommendation/summary?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user summary is 403',
      strangerSummaryRes.status === 403,
      `${strangerSummaryRes.status}`,
    );
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Recommendation Agent checks FAILED.');
    } else {
      console.log('\nAll Recommendation Agent checks passed.');
    }
  } finally {
    console.log('8. cleanup');
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
