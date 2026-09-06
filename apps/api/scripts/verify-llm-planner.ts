// Phase 28 — LLM Planner foundation checks: prompt building, a real
// LLMPlanner.plan() call (exercising the graceful-degradation fallback to
// GoalPlanner — no real OPENAI_API_KEY is configured in this environment,
// the same expected state every other agent's own LLM call site already
// tolerates), telemetry, plan history, a full LLMPlannerExecutor.execute()
// round-trip with a throwaway fake-agent workflow, and a live-server
// backward-compatibility + new-endpoint pass (routes/llm-planner.ts).
import { createChecker, api, registerAndLogin } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { buildPlannerPrompt } from '../src/ai/llm-planner/planner.prompt.js';
import { llmPlanner, plannerHistoryStore } from '../src/ai/llm-planner/planner.js';
import { llmPlannerExecutor } from '../src/ai/llm-planner/planner.executor.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = `llm-planner-foundation-workflow-${Date.now()}`;
// planner.ts's fallbackPlan() (exercised here, since no real
// OPENAI_API_KEY is configured) only keeps steps whose agentId is one of
// PLANNER_AVAILABLE_AGENTS — swap in a fake implementation under a real
// agent id (standalone process only, same pattern verify-graph-routing.ts
// uses) rather than a made-up id a fallback plan would silently drop.
const AGENT_ID = 'discovery-agent';

interface DynamicRunDto {
  planId: string;
  status: string;
  iterations: number;
  state: { executionTrace: { stepId: string }[] };
}
interface ExplainDto {
  planId: string;
  plan: { reasoning: string; steps: unknown[]; overallConfidence: number };
  source: string;
}
interface HistoryDto {
  records: { planId: string; goal: string }[];
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. buildPlannerPrompt — includes every spec #3 section');
  const messages = buildPlannerPrompt(
    { goal: 'discover my repositories', user: { id: 'u1', role: 'ADMIN' } },
    {
      conversationSummary: 'no prior conversation',
      sessionSummary: 'no session state',
      knowledgeSummary: 'no asset in scope',
      reflectionSummary: 'no prior execution referenced',
      knowledgeVersion: 'none',
    },
  );
  const userMessage = messages.find((m) => m.role === 'user')?.content ?? '';
  check('prompt lists available agents', userMessage.includes('discovery-agent'));
  check('prompt lists available tools', userMessage.includes('knowledge-search'));
  check('prompt lists approval rules', userMessage.includes('Approval rules'));
  check('prompt includes memory summary', userMessage.includes('Memory summary'));
  check('prompt includes current graph state', userMessage.includes('Current system state'));
  check('prompt includes the user goal', userMessage.includes('discover my repositories'));

  console.log('2. LLMPlanner.plan() — real call, graceful fallback, telemetry, history');
  // A unique goal per run — planner.cache.ts caches by goal (among other
  // things), and a stable goal string here would let a second run of this
  // script within the cache's TTL hit the cache instead of exercising the
  // fallback path this check depends on (see verify-plan-revision.ts's
  // identical fix).
  const record = await llmPlanner.plan({
    goal: `discover my repositories on github (verify-llm-planner ${Date.now()})`,
    user: { id: 'u1', role: 'ADMIN' },
  });
  check('plan() returns at least one step', record.plan.steps.length > 0);
  check(
    'plan() falls back gracefully (no real OPENAI_API_KEY configured in this environment)',
    record.source === 'fallback',
  );
  check(
    'overallConfidence is between 0 and 1',
    record.plan.overallConfidence >= 0 && record.plan.overallConfidence <= 1,
  );
  check('reasoning is non-empty', record.plan.reasoning.length > 0);

  const history = await plannerHistoryStore.list(50);
  check(
    'the plan just made appears in history',
    history.some((entry) => entry.planId === record.planId),
  );

  console.log('3. LLMPlannerExecutor.execute() — dynamic graph end to end');
  let calls = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_ID,
    description: 'fake agent for verify-llm-planner',
    canHandle: () => true,
    execute: () => {
      calls += 1;
      return Promise.resolve({ confidenceScore: 1, ran: true });
    },
  });
  const { registerGraphNode, unregisterGraphNode } =
    await import('../src/ai/langgraph/graph-builder.js');
  const { makeAgentNode } = await import('../src/ai/langgraph/nodes.js');
  registerGraphNode(
    AGENT_ID,
    makeAgentNode({
      stateKey: 'discovery',
      stepId: 'discovery',
      agentId: AGENT_ID,
      buildInput: () => ({}),
    }),
  );
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Phase 28 foundation workflow',
    description: 'single-step, no gating',
    steps: [{ stepId: 'discovery', agentId: AGENT_ID }],
  });

  try {
    const run = await llmPlannerExecutor.execute({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });
    check('execute() invoked the real registered agent', calls === 1);
    check('execute() reports COMPLETED', run.status === 'COMPLETED');
    check(
      'execute() ran with 1 iteration (confidence cleared the default threshold)',
      run.iterations === 1,
    );
    check(
      'execute() graphId is not a registered workflow id (ad hoc dynamic graph)',
      run.graphId !== WORKFLOW_ID,
    );
  } finally {
    workflowRegistry.unregister(WORKFLOW_ID);
    unregisterGraphNode(AGENT_ID);
    orchestratorAgentRegistry.unregister(AGENT_ID);
  }

  console.log('4. live server — new endpoints + backward compatibility');
  const user = await registerAndLogin(`verify-llm-planner-${Date.now()}@example.test`);

  const explainRes = await api<ExplainDto>('POST', '/ai/planner/explain', user.accessToken, {
    goal: 'run a full security analysis on my github account',
  });
  check('POST /ai/planner/explain 200', explainRes.status === 200, `${explainRes.status}`);
  check('explain response carries reasoning + steps', explainRes.body.plan?.steps.length > 0);

  const dynamicRes = await api<DynamicRunDto>('POST', '/ai/planner/dynamic', user.accessToken, {
    goal: 'run a risk analysis',
  });
  check('POST /ai/planner/dynamic 200', dynamicRes.status === 200, `${dynamicRes.status}`);
  check(
    'dynamic run reports a terminal status',
    ['COMPLETED', 'PARTIAL', 'FAILED'].includes(dynamicRes.body.status),
    dynamicRes.body.status,
  );
  check('dynamic run executed at least one step', dynamicRes.body.state.executionTrace.length > 0);

  const historyRes = await api<HistoryDto>('GET', '/ai/planner/history?limit=5', user.accessToken);
  check('GET /ai/planner/history 200', historyRes.status === 200, `${historyRes.status}`);
  check('history returns an array of records', Array.isArray(historyRes.body.records));

  console.log('5. backward compatibility — pre-existing AI endpoints still respond');
  const orchestratorRes = await api('POST', '/ai/orchestrator/execute', user.accessToken, {
    intent: 'risk-only',
  });
  check(
    'POST /ai/orchestrator/execute still 200',
    orchestratorRes.status === 200,
    `${orchestratorRes.status}`,
  );
  const plannerRes = await api('POST', '/ai/planner/plan', user.accessToken, {
    goal: 'risk analysis',
  });
  check('POST /ai/planner/plan still 200', plannerRes.status === 200, `${plannerRes.status}`);
  const langgraphRes = await api('POST', '/ai/langgraph/execute', user.accessToken, {
    goal: 'risk analysis',
  });
  check(
    'POST /ai/langgraph/execute still 200',
    langgraphRes.status === 200,
    `${langgraphRes.status}`,
  );

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    redis.quit().catch(() => undefined);
  });
