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
import { prisma } from '../src/db/prisma.js';
import { agentRegistry } from '../src/services/agents/agent-registry.js';
import { plannerService } from '../src/services/agents/planner.service.js';
import { taskService } from '../src/services/agents/task.service.js';
import { AgentContext } from '../src/services/agents/agent-context.js';
import type { Agent, AgentPlanHint } from '../src/services/agents/agent.interface.js';
import type { AgentTask } from '../src/services/agents/dto/agent-task.js';
import '../src/services/agents/agents/index.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const VALID_CREDENTIAL = 'agents-credential-good';
const USER_ID = 990011;
const REPO_ID = 9101;

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
}

interface JobDto {
  status: string;
}

interface TaskSummaryDto {
  taskId: string;
  agentId: string;
  status: string;
  startedAt: string;
  durationMs: number;
  attempts: number;
  error?: string;
}

interface AggregatedPlanResultDto {
  planId: string;
  requestType: string;
  assetId: string;
  status: string;
  durationMs: number;
  tasks: TaskSummaryDto[];
  data: Record<string, unknown>;
}

interface AgentListDto {
  items: { id: string; supportedRequestTypes: string[] }[];
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
          login: 'verify-agents-user',
          name: 'Verify Agents User',
          html_url: 'https://github.com/verify-agents-user',
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
            full_name: 'verify-agents-user/broken-repo',
            description: null,
            private: false,
            html_url: 'https://github.com/verify-agents-user/broken-repo',
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

  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

// The broken-repo fixture always produces >0 resources, findings, and
// policy failures — so each agent's output should never be "empty" if
// discovery actually ran. This is what catches a silently-incomplete
// discovery job that a mere "does the key exist" check would miss.
function hasNonTrivialData(
  requestType: string,
  data: Record<string, unknown> | undefined,
): boolean {
  if (!data) return false;
  switch (requestType) {
    case 'DISCOVERY_SUMMARY':
      return typeof data.totalResources === 'number' && data.totalResources > 0;
    case 'RISK_SUMMARY':
      return typeof data.openFindingsCount === 'number' && data.openFindingsCount > 0;
    case 'COMPLIANCE_SUMMARY':
      return Array.isArray(data.policyFailures) && data.policyFailures.length > 0;
    case 'RECOMMENDATIONS':
      return typeof data.totalOpen === 'number' && data.totalOpen > 0;
    default:
      return true;
  }
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

// A fake agent used only for the in-process unit checks below (retries,
// timeouts, cancellation, registry extensibility) — never registered
// against the actual running API server process, so it has no effect on
// the HTTP integration checks later in this script.
function makeFakeAgent(opts: {
  id: string;
  requestType: string;
  dependsOn?: string[];
  behavior: (attempt: number) => Promise<Record<string, unknown>>;
}): Agent {
  let attempt = 0;
  return {
    id: () => opts.id,
    supports: (requestType: string) => requestType === opts.requestType,
    plan: (): AgentPlanHint => ({ dependsOn: opts.dependsOn ?? [] }),
    execute: async () => {
      attempt += 1;
      return opts.behavior(attempt);
    },
  };
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
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. unit checks — task graph waves, cycle detection');
    const chainTasks: AgentTask[] = [
      { id: 'a', agentId: 'a', dependsOn: [], timeoutMs: 1000, maxAttempts: 1 },
      { id: 'b', agentId: 'b', dependsOn: [], timeoutMs: 1000, maxAttempts: 1 },
      { id: 'c', agentId: 'c', dependsOn: ['a'], timeoutMs: 1000, maxAttempts: 1 },
      { id: 'd', agentId: 'd', dependsOn: ['a', 'b', 'c'], timeoutMs: 1000, maxAttempts: 1 },
    ];
    const waves = taskService.buildWaves(chainTasks);
    check(
      'wave 1 is [a, b] (parallel)',
      waves[0]
        ?.map((t) => t.id)
        .sort()
        .join(',') === 'a,b',
    );
    check('wave 2 is [c] (sequential, depends on a)', waves[1]?.map((t) => t.id).join(',') === 'c');
    check('wave 3 is [d] (depends on a,b,c)', waves[2]?.map((t) => t.id).join(',') === 'd');

    const cyclic: AgentTask[] = [
      { id: 'x', agentId: 'x', dependsOn: ['y'], timeoutMs: 1000, maxAttempts: 1 },
      { id: 'y', agentId: 'y', dependsOn: ['x'], timeoutMs: 1000, maxAttempts: 1 },
    ];
    let cycleThrew = false;
    try {
      taskService.buildWaves(cyclic);
    } catch {
      cycleThrew = true;
    }
    check('cyclic dependsOn throws rather than hanging', cycleThrew);

    console.log('1. unit checks — retries, timeouts, cancellation');
    const fakeContext = new AgentContext(
      { id: 'unit-test', role: 'USER' },
      'n/a',
      new AbortController().signal,
    );

    const retryAgent = makeFakeAgent({
      id: 'retry-fake',
      requestType: 'UNIT_TEST',
      behavior: (attempt) => {
        if (attempt < 2) throw new Error('transient failure');
        return Promise.resolve({ ok: true });
      },
    });
    const retryResult = await taskService.runTask(
      { id: 'retry-fake', agentId: 'retry-fake', dependsOn: [], timeoutMs: 1000, maxAttempts: 3 },
      retryAgent,
      fakeContext,
    );
    check(
      'retry succeeds on 2nd attempt',
      retryResult.status === 'SUCCESS' && retryResult.attempts === 2,
      JSON.stringify(retryResult),
    );

    const alwaysFailsAgent = makeFakeAgent({
      id: 'fail-fake',
      requestType: 'UNIT_TEST',
      behavior: () => {
        throw new Error('permanent failure');
      },
    });
    const failResult = await taskService.runTask(
      { id: 'fail-fake', agentId: 'fail-fake', dependsOn: [], timeoutMs: 1000, maxAttempts: 2 },
      alwaysFailsAgent,
      fakeContext,
    );
    check(
      'exhausted retries end in FAILED with attempts == maxAttempts',
      failResult.status === 'FAILED' && failResult.attempts === 2,
      JSON.stringify(failResult),
    );

    const slowAgent = makeFakeAgent({
      id: 'slow-fake',
      requestType: 'UNIT_TEST',
      behavior: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)),
    });
    const timeoutResult = await taskService.runTask(
      { id: 'slow-fake', agentId: 'slow-fake', dependsOn: [], timeoutMs: 50, maxAttempts: 1 },
      slowAgent,
      fakeContext,
    );
    check(
      'slow task times out as FAILED',
      timeoutResult.status === 'FAILED' && (timeoutResult.error ?? '').includes('timed out'),
      JSON.stringify(timeoutResult),
    );

    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelledContext = new AgentContext(
      { id: 'unit-test', role: 'USER' },
      'n/a',
      cancelledController.signal,
    );
    const cancelledResult = await taskService.runTask(
      { id: 'never-runs', agentId: 'never-runs', dependsOn: [], timeoutMs: 1000, maxAttempts: 1 },
      makeFakeAgent({
        id: 'never-runs',
        requestType: 'UNIT_TEST',
        behavior: () => Promise.resolve({}),
      }),
      cancelledContext,
    );
    check(
      'pre-cancelled plan skips the task without executing it',
      cancelledResult.status === 'SKIPPED' && cancelledResult.attempts === 0,
    );

    console.log('2. unit checks — shared context avoids duplicate queries');
    let loadCount = 0;
    const sharedContext = new AgentContext(
      { id: 'unit-test', role: 'USER' },
      'n/a',
      new AbortController().signal,
    );
    const load = () =>
      sharedContext.getOrLoad('shared-key', () => Promise.resolve((loadCount += 1)));
    await load();
    await load();
    check(
      'getOrLoad only invokes the loader once for the same key',
      loadCount === 1,
      `${loadCount}`,
    );

    console.log('3. unit checks — registry + planner are extensible without core changes');
    const customAgent = makeFakeAgent({
      id: 'custom-unit-agent',
      requestType: 'CUSTOM_UNIT_REQUEST',
      behavior: () => Promise.resolve({ custom: true }),
    });
    agentRegistry.register(customAgent);
    const customPlan = plannerService.createPlan(
      'CUSTOM_UNIT_REQUEST',
      'n/a',
      new AgentContext({ id: 'unit-test', role: 'USER' }, 'n/a', new AbortController().signal),
    );
    check(
      'planner picks up a newly registered agent for its declared request type',
      customPlan.tasks.length === 1 && customPlan.tasks[0]?.agentId === 'custom-unit-agent',
    );

    console.log('4. setup — admin+category, asset, owner + another user, connected account');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('agents');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-agents-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-agents-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-agents-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Agents target',
    });
    accountId = connectRes.body.id;

    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${accountId}/discover`,
      ownerToken,
    );
    const discoveryJob = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('discovery job COMPLETED', discoveryJob.status === 'COMPLETED', discoveryJob.status);

    console.log('5. GET /agents — registry introspection');
    const listRes = await api<AgentListDto>('GET', '/agents', ownerToken);
    check('agents list status 200', listRes.status === 200);
    const ids = listRes.body.items.map((a) => a.id).sort();
    check(
      'all 5 agents registered',
      JSON.stringify(ids) ===
        JSON.stringify(['compliance', 'discovery', 'recommendation', 'report', 'risk']),
      JSON.stringify(ids),
    );
    const reportEntry = listRes.body.items.find((a) => a.id === 'report');
    check(
      'ReportAgent only supports SECURITY_REPORT',
      JSON.stringify(reportEntry?.supportedRequestTypes) === JSON.stringify(['SECURITY_REPORT']),
    );

    console.log('6. unsupported request type is rejected');
    const badReq = await api('POST', '/agents/execute', ownerToken, {
      requestType: 'NOT_A_REAL_TYPE',
      assetId,
    });
    check('unsupported request type is 400', badReq.status === 400, `${badReq.status}`);

    console.log('7. single-agent request types');
    for (const [requestType, expectedAgentId] of [
      ['DISCOVERY_SUMMARY', 'discovery'],
      ['RISK_SUMMARY', 'risk'],
      ['COMPLIANCE_SUMMARY', 'compliance'],
      ['RECOMMENDATIONS', 'recommendation'],
    ] as const) {
      const res = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
        requestType,
        assetId,
      });
      planIdsToClean.push(res.body.planId);
      check(`${requestType} status 200`, res.status === 200, `${res.status}`);
      check(
        `${requestType} runs exactly 1 task (${expectedAgentId})`,
        res.body.tasks.length === 1 && res.body.tasks[0]?.agentId === expectedAgentId,
        JSON.stringify(res.body.tasks),
      );
      check(`${requestType} plan status SUCCESS`, res.body.status === 'SUCCESS');
      check(
        `${requestType} data keyed by agentId`,
        Object.keys(res.body.data).join(',') === expectedAgentId,
      );
      // The broken-repo fixture guarantees non-trivial output on every
      // agent — asserting on real counts (not just "a key exists") is what
      // would have caught the discovery job never actually completing.
      const payload = res.body.data[expectedAgentId] as Record<string, unknown> | undefined;
      check(
        `${requestType} data is non-trivial`,
        hasNonTrivialData(requestType, payload),
        JSON.stringify(payload),
      );
    }

    console.log('8. SECURITY_REPORT — full pipeline, parallel + sequential dependencies');
    const securityRes = await api<AggregatedPlanResultDto>('POST', '/agents/execute', ownerToken, {
      requestType: 'SECURITY_REPORT',
      assetId,
    });
    planIdsToClean.push(securityRes.body.planId);
    check('SECURITY_REPORT status 200', securityRes.status === 200);
    check('SECURITY_REPORT runs all 5 tasks', securityRes.body.tasks.length === 5);
    check('SECURITY_REPORT plan status SUCCESS', securityRes.body.status === 'SUCCESS');

    const byAgent = new Map(securityRes.body.tasks.map((t) => [t.agentId, t]));
    const discoveryTask = byAgent.get('discovery')!;
    const riskTask = byAgent.get('risk')!;
    const complianceTask = byAgent.get('compliance')!;
    const recommendationTask = byAgent.get('recommendation')!;
    const reportTask = byAgent.get('report')!;

    check(
      'recommendation starts only after risk (sequential dependency)',
      new Date(recommendationTask.startedAt).getTime() >=
        new Date(riskTask.startedAt).getTime() + riskTask.durationMs,
      `recommendation=${recommendationTask.startedAt} risk=${riskTask.startedAt}+${riskTask.durationMs}`,
    );
    check(
      'report starts only after every dependency finished',
      [discoveryTask, riskTask, complianceTask, recommendationTask].every(
        (t) =>
          new Date(reportTask.startedAt).getTime() >=
          new Date(t.startedAt).getTime() + t.durationMs,
      ),
    );

    const reportData = securityRes.body.data.report as
      | {
          executive: Record<string, unknown>;
          technical: Record<string, unknown>;
          asset: Record<string, unknown>;
        }
      | undefined;
    check(
      'ReportAgent output has executive/technical/asset sections',
      !!reportData?.executive && !!reportData.technical && !!reportData.asset,
      JSON.stringify(reportData),
    );
    const executive = reportData?.executive;
    check(
      'executive section carries a non-trivial risk score and open findings count',
      typeof executive?.overallRiskScore === 'number' &&
        executive.overallRiskScore > 0 &&
        typeof executive.openFindingsCount === 'number' &&
        executive.openFindingsCount > 0,
      JSON.stringify(executive),
    );

    console.log('9. GET /agents/plans/:id — persisted plan execution audit row');
    const planRes = await api<{
      id: string;
      requestType: string;
      status: string;
      summary: unknown;
    }>('GET', `/agents/plans/${securityRes.body.planId}`, ownerToken);
    check('plan lookup status 200', planRes.status === 200);
    check('plan lookup requestType matches', planRes.body.requestType === 'SECURITY_REPORT');
    check('plan lookup status COMPLETED', planRes.body.status === 'COMPLETED');
    check('plan lookup has a summary', planRes.body.summary !== null);

    const missingPlanRes = await api('GET', '/agents/plans/does-not-exist', ownerToken);
    check('unknown plan id is 404', missingPlanRes.status === 404, `${missingPlanRes.status}`);

    console.log('10. authorization — unauthenticated and cross-user access are rejected');
    const noAuthExec = await api('POST', '/agents/execute', undefined, {
      requestType: 'DISCOVERY_SUMMARY',
      assetId,
    });
    check('unauthenticated execute is 401', noAuthExec.status === 401, `${noAuthExec.status}`);

    const noAuthList = await api('GET', '/agents', undefined);
    check('unauthenticated list is 401', noAuthList.status === 401);

    const crossUserExec = await api('POST', '/agents/execute', other.accessToken, {
      requestType: 'DISCOVERY_SUMMARY',
      assetId,
    });
    check('cross-user execute is 403', crossUserExec.status === 403, `${crossUserExec.status}`);

    const crossUserPlan = await api(
      'GET',
      `/agents/plans/${securityRes.body.planId}`,
      other.accessToken,
    );
    check('cross-user plan lookup is 403', crossUserPlan.status === 403, `${crossUserPlan.status}`);

    console.log('11. event generation — PLAN_CREATED/AGENT_STARTED/AGENT_COMPLETED/PLAN_COMPLETED');
    const eventsRes = await api<{ items: { type: string }[] }>(
      'GET',
      `/assets/${assetId}/events?limit=100`,
      ownerToken,
    );
    const eventTypes = eventsRes.body.items.map((e) => e.type);
    check('PLAN_CREATED event exists', eventTypes.includes('PLAN_CREATED'));
    check('AGENT_STARTED event exists', eventTypes.includes('AGENT_STARTED'));
    check('AGENT_COMPLETED event exists', eventTypes.includes('AGENT_COMPLETED'));
    check('PLAN_COMPLETED event exists', eventTypes.includes('PLAN_COMPLETED'));

    if (state.failed) {
      console.error('\nOne or more agent checks FAILED.');
    } else {
      console.log('\nAll agent checks passed.');
    }
  } finally {
    console.log('12. cleanup');
    mockServer.close();
    for (const planId of planIdsToClean) {
      try {
        await agentPlanExecutionRepository.delete(planId);
      } catch {
        // Already deleted or never persisted (e.g. a run that failed before create) — fine.
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
    console.log('   plan executions + policy results + findings + risk scores + resources deleted');
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
