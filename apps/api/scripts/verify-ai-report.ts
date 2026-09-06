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
import { policyResultRepository } from '../src/repositories/policy-result.repository.js';
import { agentPlanExecutionRepository } from '../src/repositories/agent-plan-execution.repository.js';
import { aiRequestLogRepository } from '../src/repositories/ai-request-log.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const GITHUB_MOCK_PORT = 3999;
const CLAUDE_MOCK_PORT = 3998;
const VALID_CREDENTIAL = 'ai-report-credential-good';
const USER_ID = 992011;
const REPO_ID = 9301;

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface JobDto {
  status: string;
}

interface AIReportMetadataDto {
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  generatedAt: string;
}

interface AIReportDto {
  aiStatus: string;
  mode: string;
  executiveSummary?: string;
  riskNarrative?: string;
  recommendationSummary?: string;
  keyObservations?: string[];
  limitations?: string[];
  metadata?: AIReportMetadataDto;
  error?: string;
}

interface ReportDataDto {
  executive: Record<string, unknown>;
  technical: Record<string, unknown>;
  asset: Record<string, unknown>;
  aiReport?: AIReportDto;
}

interface AggregatedPlanResultDto {
  planId: string;
  requestType: string;
  status: string;
  tasks: { agentId: string; status: string; error?: string }[];
  data: Record<string, unknown>;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);
    if (!authorized) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: USER_ID,
          login: 'verify-ai-report-user',
          name: 'Verify AI Report User',
          html_url: 'https://github.com/verify-ai-report-user',
          public_repos: 1,
          followers: 0,
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: REPO_ID,
            name: 'broken-repo',
            full_name: 'verify-ai-report-user/broken-repo',
            description: null,
            private: false,
            html_url: 'https://github.com/verify-ai-report-user/broken-repo',
            language: 'TypeScript',
            stargazers_count: 0,
            forks_count: 0,
            default_branch: 'main',
            archived: false,
            topics: [],
            size: 0,
            fork: false,
          },
        ]),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => server.listen(GITHUB_MOCK_PORT, () => resolve(server)));
}

// Tracks state the mock Claude server exposes to assertions: the last
// system/user content it saw (so "prompt selection" can be verified
// against the real wire request, not just the template files in
// isolation) and a togglable failure switch (so "graceful failure" can be
// exercised deterministically without depending on any particular data
// shape triggering it).
let lastSystemPrompt = '';
let lastUserContent = '';
let forceFailureMode = false;

const FULL_REPORT_TEXT = [
  '## Executive Summary',
  'This asset carries elevated risk driven by open findings and policy failures that warrant attention.',
  '',
  '## Risk Narrative',
  'The current risk score reflects a publicly visible repository with no description, which increases exposure.',
  '',
  '## Recommendation Summary',
  "Addressing the top open recommendations would meaningfully reduce this asset's exposure.",
  '',
  '## Key Observations',
  '- The repository is publicly visible',
  '- The repository has no description',
  '- The repository has no topics',
  '',
  '## Limitations',
  '- This report only reflects data already discovered, not a live re-scan',
  '- Graph traversal is sampled, not exhaustive',
].join('\n');

const SUMMARY_TEXT =
  '## Executive Summary\nThis asset shows elevated risk from a publicly visible, undocumented repository.';

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function startMockClaudeServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/messages')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      lastSystemPrompt = typeof body.system === 'string' ? body.system : '';
      const messages = (body.messages ?? []) as { content?: string }[];
      lastUserContent = messages[messages.length - 1]?.content ?? '';

      if (forceFailureMode) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
        return;
      }

      const isFullReport = lastSystemPrompt.includes('Recommendation Summary');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model,
          content: [{ type: 'text', text: isFullReport ? FULL_REPORT_TEXT : SUMMARY_TEXT }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 60, output_tokens: 40 },
        }),
      );
    })();
  });

  return new Promise((resolve) => server.listen(CLAUDE_MOCK_PORT, () => resolve(server)));
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

function reportOf(res: { body: AggregatedPlanResultDto }): ReportDataDto | undefined {
  return res.body.data.report as ReportDataDto | undefined;
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
  const planIdsToClean: string[] = [];
  const githubMock = await startMockGitHubServer();
  const claudeMock = await startMockClaudeServer();

  try {
    console.log('1. setup — admin+category, asset, owner + another user, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('ai-report');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-ai-report-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-ai-report-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-ai-report-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'AI report target',
    });
    accountId = connectRes.body.id;

    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    const discoveryJob = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('discovery job COMPLETED', discoveryJob.status === 'COMPLETED', discoveryJob.status);

    console.log('2. AI disabled — aiMode omitted keeps the exact pre-Phase-7D response shape');
    const offRes = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
    });
    planIdsToClean.push(offRes.body.planId);
    const offReport = reportOf(offRes);
    check('OFF status 200', offRes.status === 200);
    check('OFF plan status SUCCESS', offRes.body.status === 'SUCCESS');
    check(
      'OFF report has executive/technical/asset, no aiReport key',
      !!offReport?.executive &&
        !!offReport.technical &&
        !!offReport.asset &&
        !('aiReport' in (offReport ?? {})),
      JSON.stringify(offReport),
    );

    console.log('2b. AI disabled — aiMode: OFF explicitly gives the identical structured report');
    const offExplicitRes = await api<AggregatedPlanResultDto>(
      'POST',
      '/agents/execute',
      ownerToken,
      {
        requestType: 'SECURITY_REPORT',
        assetId,
        aiMode: 'OFF',
      },
    );
    planIdsToClean.push(offExplicitRes.body.planId);
    const offExplicitReport = reportOf(offExplicitRes);
    check(
      'explicit OFF structured report identical to omitted aiMode',
      JSON.stringify({
        executive: offExplicitReport?.executive,
        technical: offExplicitReport?.technical,
        asset: offExplicitReport?.asset,
      }) ===
        JSON.stringify({
          executive: offReport?.executive,
          technical: offReport?.technical,
          asset: offReport?.asset,
        }),
    );

    console.log('3. AI summary mode');
    const summaryRes = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
      aiMode: 'SUMMARY',
    });
    planIdsToClean.push(summaryRes.body.planId);
    const summarySystemPrompt = lastSystemPrompt;
    const summaryReport = reportOf(summaryRes);
    check('SUMMARY status 200', summaryRes.status === 200);
    check('SUMMARY plan status SUCCESS', summaryRes.body.status === 'SUCCESS');
    check(
      'SUMMARY structured report unaffected',
      JSON.stringify(summaryReport?.executive) === JSON.stringify(offReport?.executive) &&
        JSON.stringify(summaryReport?.technical) === JSON.stringify(offReport?.technical),
    );
    check(
      'SUMMARY aiReport has mode/status/executiveSummary only',
      summaryReport?.aiReport?.mode === 'SUMMARY' &&
        summaryReport.aiReport.aiStatus === 'SUCCESS' &&
        typeof summaryReport.aiReport.executiveSummary === 'string' &&
        summaryReport.aiReport.executiveSummary.length > 0 &&
        summaryReport.aiReport.riskNarrative === undefined &&
        summaryReport.aiReport.recommendationSummary === undefined &&
        summaryReport.aiReport.keyObservations === undefined &&
        summaryReport.aiReport.limitations === undefined,
      JSON.stringify(summaryReport?.aiReport),
    );

    console.log('4. AI full report mode');
    const fullRes = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
      aiMode: 'FULL_REPORT',
    });
    planIdsToClean.push(fullRes.body.planId);
    const fullSystemPrompt = lastSystemPrompt;
    const fullUserContent = lastUserContent;
    const fullReport = reportOf(fullRes);
    const fullAi = fullReport?.aiReport;
    check('FULL_REPORT status 200', fullRes.status === 200);
    check('FULL_REPORT plan status SUCCESS', fullRes.body.status === 'SUCCESS');
    check(
      'FULL_REPORT aiReport has all five narrative sections',
      fullAi?.mode === 'FULL_REPORT' &&
        fullAi.aiStatus === 'SUCCESS' &&
        typeof fullAi.executiveSummary === 'string' &&
        fullAi.executiveSummary.length > 0 &&
        typeof fullAi.riskNarrative === 'string' &&
        fullAi.riskNarrative.length > 0 &&
        typeof fullAi.recommendationSummary === 'string' &&
        fullAi.recommendationSummary.length > 0 &&
        Array.isArray(fullAi.keyObservations) &&
        fullAi.keyObservations.length > 0 &&
        Array.isArray(fullAi.limitations) &&
        fullAi.limitations.length > 0,
      JSON.stringify(fullAi),
    );

    console.log('5. prompt selection — SUMMARY vs FULL_REPORT render genuinely different prompts');
    check(
      'SUMMARY system prompt lacks the FULL_REPORT-only sections',
      summarySystemPrompt.includes('Executive Summary') &&
        !summarySystemPrompt.includes('Recommendation Summary'),
    );
    check(
      'FULL_REPORT system prompt includes every section instruction',
      fullSystemPrompt.includes('Executive Summary') &&
        fullSystemPrompt.includes('Risk Narrative') &&
        fullSystemPrompt.includes('Recommendation Summary') &&
        fullSystemPrompt.includes('Key Observations') &&
        fullSystemPrompt.includes('Limitations'),
    );
    check(
      'FULL_REPORT user content carries real report data (grounded, not templated boilerplate)',
      fullUserContent.includes('overallRiskScore'),
      fullUserContent.slice(0, 200),
    );

    console.log('6. provider selection — AI metadata reflects a real, resolved provider/model');
    for (const [label, metadata] of [
      ['SUMMARY', summaryReport?.aiReport?.metadata],
      ['FULL_REPORT', fullAi?.metadata],
    ] as const) {
      check(
        `${label} metadata has provider/model/tokens/cost/latency/generatedAt`,
        typeof metadata?.provider === 'string' &&
          metadata.provider.length > 0 &&
          typeof metadata.model === 'string' &&
          metadata.model.length > 0 &&
          typeof metadata.latencyMs === 'number' &&
          metadata.latencyMs >= 0 &&
          typeof metadata.promptTokens === 'number' &&
          metadata.promptTokens > 0 &&
          typeof metadata.completionTokens === 'number' &&
          metadata.completionTokens > 0 &&
          typeof metadata.totalTokens === 'number' &&
          metadata.totalTokens > 0 &&
          typeof metadata.estimatedCostUsd === 'number' &&
          metadata.estimatedCostUsd >= 0 &&
          typeof metadata.generatedAt === 'string' &&
          !Number.isNaN(Date.parse(metadata.generatedAt)),
        JSON.stringify(metadata),
      );
    }

    console.log(
      '7. graceful failure — AI failure never fails the request or the structured report',
    );
    forceFailureMode = true;
    const failRes = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
      aiMode: 'FULL_REPORT',
    });
    forceFailureMode = false;
    planIdsToClean.push(failRes.body.planId);
    const failReport = reportOf(failRes);
    check('AI failure still returns 200', failRes.status === 200, `${failRes.status}`);
    check('AI failure: plan status still SUCCESS', failRes.body.status === 'SUCCESS');
    check(
      'AI failure: structured report still present and unaffected',
      !!failReport?.executive &&
        !!failReport.technical &&
        JSON.stringify(failReport.executive) === JSON.stringify(offReport?.executive),
    );
    check(
      'AI failure: aiReport carries FAILED status and an error message, no narrative fields',
      failReport?.aiReport?.aiStatus === 'FAILED' &&
        typeof failReport.aiReport.error === 'string' &&
        failReport.aiReport.error.length > 0 &&
        failReport.aiReport.executiveSummary === undefined,
      JSON.stringify(failReport?.aiReport),
    );

    console.log('8. event generation — AI_REPORT_STARTED/COMPLETED/FAILED');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('AI_REPORT_STARTED event exists', eventTypes.includes('AI_REPORT_STARTED'));
    check('AI_REPORT_COMPLETED event exists', eventTypes.includes('AI_REPORT_COMPLETED'));
    check('AI_REPORT_FAILED event exists', eventTypes.includes('AI_REPORT_FAILED'));

    console.log('9. authorization — cross-user access is still rejected (unchanged by Phase 7D)');
    const crossUserExec = await api('POST', '/agents/execute', other.accessToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
      aiMode: 'FULL_REPORT',
    });
    check('cross-user execute is 403', crossUserExec.status === 403, `${crossUserExec.status}`);

    if (state.failed) {
      console.error('\nOne or more AI report checks FAILED.');
    } else {
      console.log('\nAll AI report checks passed.');
    }
  } finally {
    console.log('10. cleanup');
    githubMock.close();
    claudeMock.close();

    if (assetId) {
      const aiLogs = await prisma.aIRequestLog.findMany({ where: { assetId } });
      for (const log of aiLogs) {
        await aiRequestLogRepository.delete(log.id);
      }
    }

    for (const planId of planIdsToClean) {
      try {
        await agentPlanExecutionRepository.delete(planId);
      } catch {
        // Already deleted or never persisted — fine.
      }
    }

    for (const providerResourceId of [String(USER_ID), String(REPO_ID)]) {
      const resourceRow = await resourceRepository.findByProviderAndProviderResourceId(
        'github',
        providerResourceId,
      );
      if (resourceRow) {
        const policyResults = await policyResultRepository.findByResource(resourceRow.id);
        for (const result of policyResults) {
          await policyResultRepository.delete(result.id);
        }
        const findings = await findingRepository.findByResource(resourceRow.id);
        for (const finding of findings) {
          const rec = await recommendationRepository.findByFindingId(finding.id);
          if (rec) {
            await recommendationRepository.delete(rec.id);
          }
          await findingRepository.delete(finding.id);
        }
        await riskScoreRepository.deleteByScope({ scope: 'RESOURCE', resourceId: resourceRow.id });
        const outgoing = await relationshipRepository.findByFromResource(resourceRow.id);
        const incoming = await relationshipRepository.findByToResource(resourceRow.id);
        for (const rel of [...outgoing, ...incoming]) {
          await relationshipRepository.delete(rel.id);
        }
        await resourceRepository.delete(resourceRow.id);
      }
    }
    if (accountId) {
      await riskScoreRepository.deleteByScope({ scope: 'ACCOUNT', accountId });
    }
    if (assetId) {
      await riskScoreRepository.deleteByScope({ scope: 'ASSET', assetId });
    }
    console.log(
      '   ai request logs + plan executions + policy results + findings + risk scores + resources deleted',
    );

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

  if (state.failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
