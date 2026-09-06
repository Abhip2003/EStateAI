// Phase 28 (LLM Planner) spec #8 — Reflection Loop. Confirms
// LLMPlannerExecutor actually calls llmPlanner.revise() again when the
// executed plan's reflected confidence stays below the configured
// threshold, and that it stops at "Maximum 3 iterations" rather than
// looping forever. Uses a deliberately unreachable confidence threshold
// (0.99) so the loop is forced to run to its cap every time,
// deterministically, without depending on real LLM output quality.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { InMemoryStore } from '../src/ai/memory/in-memory-store.js';
import { GraphCheckpointStore } from '../src/ai/langgraph/graph.checkpoint.js';
import { LLMPlannerExecutor } from '../src/ai/llm-planner/planner.executor.js';
import { redis } from '../src/cache/redis.js';

// A unique id per run — not just per script — since goal is used
// verbatim as the LLM Planner's cache key (planner.cache.ts's
// computeCacheKey), and the two executor instances below deliberately
// run the identical goal twice each; a stable, hardcoded id would let a
// second run of this script within the cache's TTL silently hit
// planner.cache.ts's cache instead of exercising the fallback path this
// script's checks depend on.
const WORKFLOW_ID = `llm-planner-revision-workflow-${Date.now()}`;
// GoalPlanner's fallback path (planner.ts's fallbackPlan()) only accepts
// steps whose agentId is one of PLANNER_AVAILABLE_AGENTS — every real,
// registered production workflow already only ever uses these ids, so
// this script swaps in fake, low-confidence implementations under the
// two real agent ids (standalone-process only, same pattern
// verify-graph-routing.ts uses), rather than inventing new agent ids a
// fallback plan would silently drop.
const AGENTS = ['discovery-agent', 'risk-agent'] as const;

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const calls: Record<string, number> = {};

  for (const agentId of AGENTS) {
    calls[agentId] = 0;
    orchestratorAgentRegistry.register({
      id: agentId,
      description: 'low-confidence fake agent for verify-plan-revision',
      canHandle: () => true,
      execute: () => {
        calls[agentId] += 1;
        return Promise.resolve({ confidenceScore: 0.3, resourceCount: 1 });
      },
    });
  }
  // GoalPlanner (ai/planner/goal-planner.ts) delegates workflow selection
  // to the existing orchestrator Planner (ai/orchestrator/planner.ts) —
  // registering a real, matching workflow here is what makes the LLM
  // Planner's deterministic fallback path (exercised because no
  // OPENAI_API_KEY is configured in this environment, matching every
  // other agent's own graceful-degradation behavior) resolve to
  // something with real, executable steps.
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Phase 28 revision-loop workflow',
    description: 'discovery -> risk, both intentionally low confidence',
    steps: [
      { stepId: 'discovery', agentId: AGENTS[0] },
      { stepId: 'risk', agentId: AGENTS[1], dependsOn: ['discovery'] },
    ],
  });

  try {
    console.log('1. an unreachable confidence threshold forces the loop to its cap');
    const executor = new LLMPlannerExecutor(
      new GraphCheckpointStore(new InMemoryStore()),
      0.99, // confidenceThreshold — no real run can ever reach this
      3, // maxIterations — spec #8's own cap
    );
    const result = await executor.execute({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });

    check('iterations reaches the configured cap of 3', result.iterations === 3);
    check('one plan record is produced per iteration', result.planRecords.length === 3);
    check(
      'every plan record source is "fallback" (no LLM provider configured in this environment)',
      result.planRecords.every((record) => record.source === 'fallback'),
    );
    check(
      'plan record iteration numbers are 1, 2, 3 in order',
      result.planRecords.map((record) => record.iterations).join(',') === '1,2,3',
    );
    check(
      'later plan records carry a revisionReason',
      result.planRecords[1].revisionReason !== undefined,
    );
    check('the final run still completed (not stuck FAILED)', result.status === 'COMPLETED');
    check(
      `each agent was invoked once per iteration (3x) — got discovery=${calls[AGENTS[0]]}, risk=${calls[AGENTS[1]]}`,
      calls[AGENTS[0]] === 3 && calls[AGENTS[1]] === 3,
    );

    console.log('2. a reachable confidence threshold stops after a single iteration');
    const permissiveExecutor = new LLMPlannerExecutor(
      new GraphCheckpointStore(new InMemoryStore()),
      0, // any real confidence clears this
      3,
    );
    const permissiveResult = await permissiveExecutor.execute({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });
    check(
      'iterations stays at 1 when the threshold is trivially satisfied',
      permissiveResult.iterations === 1,
    );
    check('only one plan record is produced', permissiveResult.planRecords.length === 1);
  } finally {
    workflowRegistry.unregister(WORKFLOW_ID);
    for (const agentId of AGENTS) orchestratorAgentRegistry.unregister(agentId);
  }

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
