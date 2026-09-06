// Phase 25 — reasoning-first API checks. Two parts, same shape as
// verify-multi-agent-collaboration.ts:
//
// Part B (in-process, no live server) — proves Plan Revision with a
// synthetic always-failing agent, since the real Discovery Agent
// swallows a bad GitHub credential into a graceful low-confidence
// SUCCESS output rather than throwing (see discovery.executor.ts) —
// there is no way to make it produce a genuine FAILED step from the
// outside, so a fake agent is the only way to exercise the adaptive
// skip-on-failure condition ReasoningOrchestrator attaches per step.
//
// Part A (HTTP, against a live server + mock GitHub) — exercises
// POST /ai/planner/plan, GET /ai/planner/:id, and
// GET /ai/reflection/:executionId end to end for a fully successful run,
// plus backward compatibility with POST /ai/orchestrator/execute.
import http from 'node:http';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { reasoningFoundation } from '../src/ai/planner/reasoning.js';
import { redis } from '../src/cache/redis.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'valid-planning-credential';

interface AccountDto {
  id: string;
}

interface ReasoningPlanDto {
  planId: string;
  goal: string;
  workflowId: string;
  steps: { stepId: string; agentId: string; dependsOn: string[]; tools: string[] }[];
  requiredAgents: string[];
  requiredTools: string[];
  estimatedComplexity: string;
  estimatedDurationMs: number;
  confidence: number;
  revisionOf?: string;
}
interface ExecutionResultDto {
  executionId: string;
  status: string;
  steps: { stepId: string; agentId: string; status: string }[];
}
interface ReflectionReportDto {
  executionId: string;
  planId: string;
  finalPlanId: string;
  succeededSteps: string[];
  failedSteps: string[];
  skippedSteps: string[];
  criticScore: number;
  overallConfidence: number;
  notes: string[];
}
interface RunOutputDto {
  plan: ReasoningPlanDto;
  finalPlan: ReasoningPlanDto;
  result: ExecutionResultDto;
  critic: { score: number; findings: unknown[]; missingEvidence: string[] };
  reflection: ReflectionReportDto;
}

async function runPartB(
  check: (label: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  console.log('Part B — in-process Plan Revision: a genuinely failed step skips its dependents');

  orchestratorAgentRegistry.register({
    id: 'planning-source-fails',
    description: 'fake always-failing source agent',
    canHandle: () => true,
    execute: () => Promise.reject(new Error('synthetic planning revision test failure')),
  });
  orchestratorAgentRegistry.register({
    id: 'planning-dependent',
    description: 'fake dependent agent (should be skipped, never called)',
    canHandle: () => true,
    execute: () => Promise.resolve({ shouldNeverRun: true }),
  });
  orchestratorAgentRegistry.register({
    id: 'planning-independent',
    description: 'fake independent agent (no dependency on the failing step)',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1, ran: true }),
  });
  workflowRegistry.register({
    id: 'planning-revision-test-workflow',
    name: 'Planning Revision Test',
    description: 'source (fails) -> dependent (should be skipped); independent runs regardless',
    steps: [
      { stepId: 'source', agentId: 'planning-source-fails' },
      { stepId: 'dependent', agentId: 'planning-dependent', dependsOn: ['source'] },
      { stepId: 'independent', agentId: 'planning-independent' },
    ],
  });

  try {
    const output = await reasoningFoundation.service.run({
      goal: 'planning-revision-test-workflow',
      user: { id: 'u1', role: 'ADMIN' },
    });

    check(
      'execution status is PARTIAL (one real failure, one real success)',
      output.result.status === 'PARTIAL',
      output.result.status,
    );
    const sourceStep = output.result.steps.find((s) => s.stepId === 'source');
    check('source step FAILED (a real thrown exception)', sourceStep?.status === 'FAILED');
    const dependentStep = output.result.steps.find((s) => s.stepId === 'dependent');
    check(
      'dependent step SKIPPED via the adaptive condition, never actually invoked',
      dependentStep?.status === 'SKIPPED',
    );
    const independentStep = output.result.steps.find((s) => s.stepId === 'independent');
    check(
      'independent step (no dependency on the failure) still SUCCEEDED',
      independentStep?.status === 'SUCCESS',
    );
    check(
      'finalPlan was revised (new planId) and dropped source+dependent, kept independent',
      output.finalPlan.planId !== output.plan.planId &&
        output.finalPlan.steps
          .map((s) => s.stepId)
          .sort()
          .join(',') === 'independent',
      JSON.stringify(output.finalPlan.steps),
    );
    check(
      'reflection lists source as failed and dependent as skipped',
      output.reflection.failedSteps.includes('source') &&
        output.reflection.skippedSteps.includes('dependent'),
      JSON.stringify(output.reflection),
    );
    check(
      'reflection notes explain the revision',
      output.reflection.notes.some((n) => n.startsWith('plan revised')),
      JSON.stringify(output.reflection.notes),
    );
  } finally {
    orchestratorAgentRegistry.unregister('planning-source-fails');
    orchestratorAgentRegistry.unregister('planning-dependent');
    orchestratorAgentRegistry.unregister('planning-independent');
    workflowRegistry.unregister('planning-revision-test-workflow');
  }
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);

    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 881100,
          login: 'verify-planning-user',
          name: 'Verify Planning User',
          html_url: 'https://github.com/verify-planning-user',
          public_repos: 0,
          followers: 0,
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/user/repos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
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
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  await runPartB(check);

  console.log('\nPart A — HTTP: POST /ai/planner/plan end to end');
  const stamp = Date.now();
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, owner, asset, valid connected GitHub account');
    const { categoryId } = await createAdminAndCategory('planning');
    const owner = await registerAndLogin(`verify-planning-owner-${stamp}@example.test`);
    const token = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', token, {
      categoryId,
      name: `verify-planning-asset-${stamp}`,
    });
    const assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', token, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Planning verify target',
    });
    const accountId = connectRes.body.id;

    console.log('1. POST /ai/planner/plan — a goal that resolves to full-security-analysis');
    const planRes = await api<RunOutputDto>('POST', '/ai/planner/plan', token, {
      goal: 'Generate a complete security report',
      assets: [{ id: assetId }],
      connectedAccounts: [{ id: accountId, provider: 'github' }],
    });
    check('POST /ai/planner/plan status 200', planRes.status === 200, `${planRes.status}`);
    check(
      'plan resolved to full-security-analysis with 5 steps',
      planRes.body.plan?.workflowId === 'full-security-analysis' &&
        planRes.body.plan.steps.length === 5,
    );
    check('requiredAgents lists all 5 agent ids', planRes.body.plan?.requiredAgents.length === 5);
    check('estimatedComplexity is HIGH', planRes.body.plan?.estimatedComplexity === 'HIGH');
    check(
      'confidence is a number in [0,1]',
      planRes.body.plan?.confidence >= 0 && planRes.body.plan?.confidence <= 1,
    );
    check(
      'execution COMPLETED (real credential, all 5 agents ran)',
      planRes.body.result?.status === 'COMPLETED',
      planRes.body.result?.status,
    );
    check(
      'every step SUCCESS',
      planRes.body.result?.steps.every((s) => s.status === 'SUCCESS'),
      JSON.stringify(planRes.body.result?.steps),
    );
    check(
      'finalPlan === plan on a clean run',
      planRes.body.finalPlan?.planId === planRes.body.plan?.planId,
    );
    check(
      'critic score is high for a clean run',
      planRes.body.critic?.score > 0.5,
      `${planRes.body.critic?.score}`,
    );
    check(
      'reflection.overallConfidence present',
      typeof planRes.body.reflection?.overallConfidence === 'number',
    );

    console.log('2. GET /ai/planner/:id — the persisted plan round-trips');
    const getPlanRes = await api<ReasoningPlanDto>(
      'GET',
      `/ai/planner/${planRes.body.plan.planId}`,
      token,
    );
    check('GET plan status 200', getPlanRes.status === 200, `${getPlanRes.status}`);
    check(
      'fetched plan matches the one returned by POST',
      getPlanRes.body.planId === planRes.body.plan.planId,
    );

    console.log('3. GET /ai/reflection/:executionId — the persisted reflection round-trips');
    const getReflectionRes = await api<ReflectionReportDto>(
      'GET',
      `/ai/reflection/${planRes.body.result.executionId}`,
      token,
    );
    check(
      'GET reflection status 200',
      getReflectionRes.status === 200,
      `${getReflectionRes.status}`,
    );
    check(
      'fetched reflection matches the executionId',
      getReflectionRes.body.executionId === planRes.body.result.executionId,
    );

    console.log('4. GET /ai/planner/:id — unknown id returns 404, not a crash');
    const missingRes = await api('GET', '/ai/planner/does-not-exist', token);
    check('unknown planId returns 404', missingRes.status === 404, `${missingRes.status}`);

    console.log('5. Backward compatibility — POST /ai/orchestrator/execute is unaffected');
    const orchestratorRes = await api('POST', '/ai/orchestrator/execute', token, {
      intent: 'Generate a complete security report',
      assets: [{ id: assetId }],
      connectedAccounts: [{ id: accountId, provider: 'github' }],
    });
    check(
      'plain orchestrator execute still returns 200',
      orchestratorRes.status === 200,
      `${orchestratorRes.status}`,
    );
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll planning (Phase 25 e2e) checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
