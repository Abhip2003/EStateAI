// Phase 20 — Multi-Agent Collaboration & Shared Context. Verifies the
// upgrade from a routed single-agent system to a collaborative DAG:
// shared state updates, agent handoff, execution order, failure
// isolation, recommendation aggregation, and trace history. Two parts,
// same shape as every other Phase 20 verify script:
//
// Part B (in-process, no live server) — proves the underlying mechanics
// with synthetic fake agents: WorkflowEngine still runs a downstream step
// after an upstream failure (failure isolation), and Executor now
// stamps durationMs/confidence onto every AgentOutputEntry (the
// executor.ts change this phase made).
//
// Part A (HTTP, against a live server + mock GitHub) — runs the real
// `full-security-analysis` workflow (Discovery -> Risk & Compliance ->
// Recommendation -> Report) via POST /ai/orchestrator/execute against a
// repository that fails both a risk rule and a compliance policy on the
// same resource, so the cross-reference in
// recommendation.aggregate.ts's mergeRecommendations() has something
// real to find.
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
import { orchestratorFoundation } from '../src/ai/orchestrator/orchestrator.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import type { OrchestrationContext } from '../src/ai/orchestrator/execution.context.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-multi-agent-collab-credential';

async function runPartB(
  check: (label: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  console.log('Part B — in-process shared-state / handoff / failure-isolation mechanics');

  const sourceCalls: string[] = [];

  orchestratorAgentRegistry.register({
    id: 'collab-source',
    description: 'fake source agent',
    canHandle: () => true,
    execute: () => {
      sourceCalls.push('collab-source');
      return Promise.resolve({ confidenceScore: 0.9, findings: ['synthetic-finding'] });
    },
  });
  orchestratorAgentRegistry.register({
    id: 'collab-fails',
    description: 'fake always-failing agent',
    canHandle: () => true,
    execute: () => {
      sourceCalls.push('collab-fails');
      return Promise.reject(new Error('synthetic failure for collaboration isolation test'));
    },
  });
  orchestratorAgentRegistry.register({
    id: 'collab-consumer',
    description: 'fake downstream consumer agent',
    canHandle: () => true,
    execute: (_input: unknown, context: OrchestrationContext) => {
      sourceCalls.push('collab-consumer');
      // Phase 20 goal #3 — reads a sibling step's output straight off the
      // shared OrchestrationContext, the same mechanism
      // recommendation.aggregate.ts's resolveHandoffFromContext uses.
      const sourceEntry = context.agentOutputs.find((e) => e.agentId === 'collab-source');
      return Promise.resolve({
        confidenceScore: 1,
        sawSourceOutput: !!sourceEntry,
        agentOutputCountAtRunTime: context.agentOutputs.length,
      });
    },
  });

  workflowRegistry.register({
    id: 'collab-test-workflow',
    name: 'Collaboration Test Workflow',
    description: 'source -> (fails, consumer depends on both)',
    steps: [
      { stepId: 'source', agentId: 'collab-source' },
      { stepId: 'fails', agentId: 'collab-fails', dependsOn: ['source'] },
      { stepId: 'consumer', agentId: 'collab-consumer', dependsOn: ['source', 'fails'] },
    ],
  });

  try {
    const result = await orchestratorFoundation.service.execute({
      intent: 'collab-test-workflow',
      user: { id: 'verify-multi-agent-collab-user', role: 'USER' },
      assets: [],
    });

    check(
      'workflow status is PARTIAL (one step failed, others succeeded)',
      result.status === 'PARTIAL',
      result.status,
    );
    check(
      'source step SUCCESS',
      result.steps.find((s) => s.stepId === 'source')?.status === 'SUCCESS',
    );
    check('fails step FAILED', result.steps.find((s) => s.stepId === 'fails')?.status === 'FAILED');
    check(
      'consumer step still SUCCESS despite an upstream sibling failing (Phase 20 goal #8 — failure isolation)',
      result.steps.find((s) => s.stepId === 'consumer')?.status === 'SUCCESS',
    );
    check(
      'every registered step actually executed, in dependency order',
      sourceCalls[0] === 'collab-source' &&
        sourceCalls.includes('collab-fails') &&
        sourceCalls[sourceCalls.length - 1] === 'collab-consumer',
      sourceCalls.join(','),
    );

    const consumerOutput = result.data['collab-consumer'] as
      { sawSourceOutput?: boolean; agentOutputCountAtRunTime?: number } | undefined;
    check(
      "consumer read the source step's output off shared OrchestrationContext (agent handoff)",
      consumerOutput?.sawSourceOutput === true,
    );
    check(
      'consumer saw 2 prior agentOutputs entries (source + fails) at run time — shared state updates correctly',
      consumerOutput?.agentOutputCountAtRunTime === 2,
      `${consumerOutput?.agentOutputCountAtRunTime}`,
    );

    const status = await orchestratorFoundation.service.getStatus(result.executionId);
    const context = status?.context;
    check('execution state is persisted and retrievable', !!status);
    check('trace has 3 agentOutputs entries', context?.agentOutputs.length === 3);
    check(
      'every trace entry has a non-negative durationMs (Phase 20 executor.ts addition)',
      !!context?.agentOutputs.every((e) => typeof e.durationMs === 'number' && e.durationMs >= 0),
    );
    const sourceEntry = context?.agentOutputs.find((e) => e.agentId === 'collab-source');
    check(
      'source entry carries confidence=0.9 read off its own confidenceScore output field',
      sourceEntry?.confidence === 0.9,
      `${sourceEntry?.confidence}`,
    );
    const failsEntry = context?.agentOutputs.find((e) => e.agentId === 'collab-fails');
    check(
      'failed entry has no confidence (no output to read one from)',
      failsEntry?.confidence === undefined,
    );
  } finally {
    orchestratorAgentRegistry.unregister('collab-source');
    orchestratorAgentRegistry.unregister('collab-fails');
    orchestratorAgentRegistry.unregister('collab-consumer');
    workflowRegistry.unregister('collab-test-workflow');
  }
}

interface AccountDto {
  id: string;
}
interface EnqueueResponseDto {
  jobId: string;
  status: string;
}

async function pollJobSettled(
  jobId: string,
  token: string,
  timeoutMs = 15_000,
): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: string };
  do {
    const res = await api<{ status: string }>('GET', `/jobs/${jobId}`, token);
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
          id: 992288,
          login: 'verify-multi-agent-collab-user',
          name: 'Verify Multi-Agent Collab User',
          html_url: 'https://github.com/verify-multi-agent-collab-user',
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
            id: 9001,
            name: 'multi-agent-collab-noncompliant-repo',
            full_name: 'verify-multi-agent-collab-user/multi-agent-collab-noncompliant-repo',
            private: false,
            html_url:
              'https://github.com/verify-multi-agent-collab-user/multi-agent-collab-noncompliant-repo',
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

  await runPartB(check);

  console.log('\nPart A — HTTP: full-security-analysis end-to-end collaboration');
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
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('multi-agent-collab');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-multi-agent-collab-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-multi-agent-collab-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Multi-agent collaboration discovery target',
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

    console.log(
      '1. GET /ai/orchestrator/workflows — new Phase 20 dynamic-handoff templates are registered',
    );
    const workflowsRes = await api<{ items: { id: string }[] }>(
      'GET',
      '/ai/orchestrator/workflows',
      ownerToken,
    );
    check('workflows status 200 (existing API still works)', workflowsRes.status === 200);
    check(
      'discovery-recommendation workflow is registered',
      workflowsRes.body.items.some((w) => w.id === 'discovery-recommendation'),
    );
    check(
      'risk-recommendation workflow is registered',
      workflowsRes.body.items.some((w) => w.id === 'risk-recommendation'),
    );

    console.log('2. POST /ai/orchestrator/execute — full-security-analysis, real 5-agent DAG');
    interface RecommendationViewDto {
      title: string;
      relatedCompliancePolicyCodes: string[];
      sourceAgents: string[];
    }
    interface ExecuteResultDto {
      executionId: string;
      workflowId: string;
      status: string;
      steps: { stepId: string; agentId: string; status: string }[];
      data: Record<string, unknown>;
    }
    const executeRes = await api<ExecuteResultDto>('POST', '/ai/orchestrator/execute', ownerToken, {
      intent: 'full-security-analysis',
      assets: [{ id: assetId }],
      connectedAccounts: [{ id: accountId, provider: 'github' }],
    });
    check('execute status 200', executeRes.status === 200, `${executeRes.status}`);
    check(
      'workflow COMPLETED (all 5 agents succeeded)',
      executeRes.body.status === 'COMPLETED',
      executeRes.body.status,
    );
    check('5 steps ran', executeRes.body.steps.length === 5, `${executeRes.body.steps.length}`);
    check(
      'every step SUCCESS',
      executeRes.body.steps.every((s) => s.status === 'SUCCESS'),
      JSON.stringify(executeRes.body.steps.map((s) => `${s.stepId}:${s.status}`)),
    );

    const recommendationOutput = executeRes.body.data['recommendation-agent'] as
      | {
          recommendations: RecommendationViewDto[];
          handoffSources: { agentId: string; used: boolean; origin: string }[];
        }
      | undefined;
    check(
      'recommendation-agent produced recommendations',
      (recommendationOutput?.recommendations.length ?? 0) > 0,
    );
    check(
      'recommendation-agent handoff used LIVE context for both risk-agent and compliance-agent (Phase 20 goal #2)',
      !!recommendationOutput?.handoffSources.every((s) => s.used && s.origin === 'context'),
      JSON.stringify(recommendationOutput?.handoffSources),
    );
    check(
      'at least one recommendation cross-references a Compliance Agent policy code on the same resource (Phase 20 goal #6)',
      !!recommendationOutput?.recommendations.some(
        (r) => r.relatedCompliancePolicyCodes.length > 0,
      ),
      JSON.stringify(
        recommendationOutput?.recommendations.map((r) => r.relatedCompliancePolicyCodes),
      ),
    );

    const reportOutput = executeRes.body.data['report-agent'] as
      | {
          sections: { id: string; status: string; origin: string }[];
          executive: {
            overallRiskScore: number | null;
            complianceScore: number | null;
            recommendationCount: number | null;
          };
        }
      | undefined;
    check('report-agent produced 4 sections', reportOutput?.sections.length === 4);
    check(
      'every report section is INCLUDED via live context (Phase 20 goal #7 — execution trace / aggregation)',
      !!reportOutput?.sections.every((s) => s.status === 'INCLUDED' && s.origin === 'context'),
      JSON.stringify(reportOutput?.sections),
    );
    check(
      'executive.overallRiskScore is populated',
      reportOutput?.executive.overallRiskScore !== null,
    );
    check(
      'executive.complianceScore is populated',
      reportOutput?.executive.complianceScore !== null,
    );
    check(
      'executive.recommendationCount is positive',
      (reportOutput?.executive.recommendationCount ?? 0) > 0,
    );

    console.log('3. GET /ai/orchestrator/status?executionId= — full shared-state trace');
    const statusRes = await api<{
      context: {
        agentOutputs: {
          stepId: string;
          agentId: string;
          status: string;
          durationMs?: number;
          confidence?: number;
        }[];
      };
    }>('GET', `/ai/orchestrator/status?executionId=${executeRes.body.executionId}`, ownerToken);
    check('status endpoint 200', statusRes.status === 200, `${statusRes.status}`);
    // Each real agent also records its own internal checkpoint entry
    // (e.g. stepId 'compliance.evaluating', a pre-existing convention from
    // compliance.executor.ts/risk.executor.ts) alongside the one the
    // top-level Executor records for the workflow step itself (stepId
    // 'compliance') — only the latter carries durationMs/confidence
    // (executor.ts's onStepComplete), so trace assertions here filter down
    // to just the 5 top-level step entries.
    const topLevelStepIds = new Set([
      'discovery',
      'risk',
      'compliance',
      'recommendation',
      'report',
    ]);
    const topLevelEntries = statusRes.body.context.agentOutputs.filter((e) =>
      topLevelStepIds.has(e.stepId),
    );
    check(
      'agentOutputs trace has at least 10 entries (5 top-level step entries + per-agent internal checkpoints)',
      statusRes.body.context.agentOutputs.length >= 10,
      `${statusRes.body.context.agentOutputs.length}`,
    );
    check(
      'exactly 5 top-level step entries, one per workflow step',
      topLevelEntries.length === 5,
      `${topLevelEntries.length}`,
    );
    check(
      'every top-level step entry has a non-negative durationMs',
      topLevelEntries.every((e) => typeof e.durationMs === 'number' && e.durationMs >= 0),
    );
    check(
      'every top-level step entry has a confidence score (every agent exposes confidenceScore)',
      topLevelEntries.every(
        (e) => typeof e.confidence === 'number' && e.confidence >= 0 && e.confidence <= 1,
      ),
      JSON.stringify(topLevelEntries.map((e) => e.confidence)),
    );

    console.log(
      '4. GET /ai/orchestrator/history — this execution is recorded (existing API still works)',
    );
    const historyRes = await api<{ items: { executionId: string }[] }>(
      'GET',
      '/ai/orchestrator/history',
      ownerToken,
    );
    check('history status 200', historyRes.status === 200, `${historyRes.status}`);
    check(
      'history includes this execution',
      historyRes.body.items.some((item) => item.executionId === executeRes.body.executionId),
    );

    if (state.failed) {
      console.error('\nOne or more Multi-Agent Collaboration checks FAILED.');
    } else {
      console.log('\nAll Multi-Agent Collaboration checks passed.');
    }
  } finally {
    console.log('5. cleanup');
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
