// Phase 20 — Report Agent checks. Same two-part shape as
// verify-compliance-agent.ts/verify-recommendation-agent.ts. The
// AI_REPORT job dispatcher path calls ReportAgent standalone (no live
// OrchestrationContext handoff from sibling steps), so this exercises
// the memory-fallback and MISSING-section paths (report.executor.ts) —
// the live-context INCLUDED path is covered by
// verify-multi-agent-collaboration.ts, which runs a real orchestrator
// workflow with every step present.
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
import { reportAgent } from '../src/ai/agents/report/index.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-report-agent-credential';

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}
interface ReportSectionDto {
  id: string;
  title: string;
  status: string;
  origin: string;
  content: string;
}
interface JobDto {
  status: string;
  error?: string | null;
  result: {
    status?: string;
    assetId?: string;
    summary?: string;
    sections?: ReportSectionDto[];
    executive?: {
      recommendationCount: number | null;
      topRecommendations: { title: string; priority: string }[];
    };
    confidenceScore?: number;
    warnings?: string[];
    errors?: string[];
  } | null;
}
interface HistoryDto {
  items: { assetId: string; status: string; sectionCount: number }[];
}
interface SummaryDto {
  status: string;
  sectionCount?: number;
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
          id: 992277,
          login: 'verify-report-agent-user',
          name: 'Verify Report Agent User',
          html_url: 'https://github.com/verify-report-agent-user',
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
            id: 8001,
            name: 'report-agent-noncompliant-repo',
            full_name: 'verify-report-agent-user/report-agent-noncompliant-repo',
            private: false,
            html_url: 'https://github.com/verify-report-agent-user/report-agent-noncompliant-repo',
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
    'report-agent is registered in orchestratorAgentRegistry',
    orchestratorAgentRegistry.isRegistered('report-agent'),
  );
  check(
    'orchestratorAgentRegistry.get resolves the same instance',
    orchestratorAgentRegistry.get('report-agent') === reportAgent,
  );
  check('reportAgent.canHandle("generate report")', reportAgent.canHandle('generate report'));
  check(
    'reportAgent.canHandle("DISCOVER_ASSETS") is false',
    !reportAgent.canHandle('DISCOVER_ASSETS'),
  );
  check(
    'tool "report_asset_lookup" is registered',
    aiFoundation.toolRegistry.has('report_asset_lookup'),
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
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('report-agent');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-report-agent-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-report-agent-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Report Agent discovery target',
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

    console.log('0b. setup — populate RecommendationMemory so the report can fall back to it');
    const recAnalyzeRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/recommendation/analyze',
      ownerToken,
      { assetId },
    );
    jobIds.push(recAnalyzeRes.body.jobId);
    const recSettled = await pollJobSettled(recAnalyzeRes.body.jobId, ownerToken);
    check(
      'setup recommendation job COMPLETED',
      recSettled.status === 'COMPLETED',
      recSettled.status,
    );

    console.log('1. unauthorized — /ai/report/generate without a token is rejected');
    const noAuth = await api('POST', '/ai/report/generate', undefined, { assetId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/report/generate — enqueues an AI_REPORT job (202)');
    const generateRes = await api<EnqueueResponseDto>('POST', '/ai/report/generate', ownerToken, {
      assetId,
    });
    check('status 202', generateRes.status === 202, `${generateRes.status}`);
    check('jobId present', typeof generateRes.body.jobId === 'string');
    jobIds.push(generateRes.body.jobId);

    console.log(
      '3. job completes — ReportAgentOutput-shaped result, mixed memory/MISSING sections',
    );
    const settled = await pollJobSettled(generateRes.body.jobId, ownerToken);
    check('job status COMPLETED', settled.status === 'COMPLETED', settled.status);
    check(
      'result.status is PARTIAL (standalone run — Risk/Compliance never ran for this asset)',
      settled.result?.status === 'PARTIAL',
      settled.result?.status,
    );
    check('assetId matches', settled.result?.assetId === assetId);
    check('sections.length is 4', settled.result?.sections?.length === 4);

    const recommendationSection = settled.result?.sections?.find(
      (s) => s.id === 'recommendation-agent',
    );
    check('recommendation-agent section is INCLUDED', recommendationSection?.status === 'INCLUDED');
    check(
      'recommendation-agent section origin is memory (standalone fallback)',
      recommendationSection?.origin === 'memory',
      recommendationSection?.origin,
    );

    const riskSection = settled.result?.sections?.find((s) => s.id === 'risk-agent');
    check(
      'risk-agent section is MISSING (Risk Agent never ran for this asset)',
      riskSection?.status === 'MISSING',
      riskSection?.status,
    );

    const discoverySection = settled.result?.sections?.find((s) => s.id === 'discovery-agent');
    check(
      'discovery-agent section is MISSING (Discovery memory is keyed by accountId, no assetId fallback)',
      discoverySection?.status === 'MISSING',
      discoverySection?.status,
    );

    check(
      'summary is a non-empty string',
      typeof settled.result?.summary === 'string' && (settled.result?.summary.length ?? 0) > 0,
    );
    check(
      'confidenceScore is in (0,1] given at least one included section',
      (settled.result?.confidenceScore ?? 0) > 0 && (settled.result?.confidenceScore ?? 0) <= 1,
      `${settled.result?.confidenceScore}`,
    );
    check(
      'no errors on a partial-but-successful run',
      (settled.result?.errors?.length ?? -1) === 0,
    );

    console.log('4. GET /ai/report/history — returns the run just completed');
    const historyRes = await api<HistoryDto>(
      'GET',
      `/ai/report/history?assetId=${assetId}`,
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      "history includes this asset's run",
      historyRes.body.items.some((item) => item.assetId === assetId),
    );

    console.log('5. GET /ai/report/summary — reflects the last run');
    const summaryRes = await api<SummaryDto>(
      'GET',
      `/ai/report/summary?assetId=${assetId}`,
      ownerToken,
    );
    check('summary endpoint 200', summaryRes.status === 200, `${summaryRes.status}`);
    check(
      'summary reflects 4 sections',
      summaryRes.body.sectionCount === 4,
      `${summaryRes.body.sectionCount}`,
    );

    console.log(
      '6. missing asset target — enqueue against a nonexistent asset is rejected up front (404)',
    );
    const missingAssetRes = await api<EnqueueResponseDto>(
      'POST',
      '/ai/report/generate',
      ownerToken,
      {
        assetId: 'nonexistent-asset-id-does-not-exist',
      },
    );
    check('nonexistent asset is 404', missingAssetRes.status === 404, `${missingAssetRes.status}`);

    console.log('7. cross-user access — history/summary are ownership-checked');
    const stranger = await registerAndLogin(`verify-report-agent-stranger-${stamp}@example.test`);
    const strangerHistoryRes = await api(
      'GET',
      `/ai/report/history?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user history is 403',
      strangerHistoryRes.status === 403,
      `${strangerHistoryRes.status}`,
    );
    const strangerSummaryRes = await api(
      'GET',
      `/ai/report/summary?assetId=${assetId}`,
      stranger.accessToken,
    );
    check(
      'cross-user summary is 403',
      strangerSummaryRes.status === 403,
      `${strangerSummaryRes.status}`,
    );
    await userRepository.delete(stranger.id);

    if (state.failed) {
      console.error('\nOne or more Report Agent checks FAILED.');
    } else {
      console.log('\nAll Report Agent checks passed.');
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
