// Phase 28 (LLM Planner) spec #6 — Dynamic Graph. Confirms
// buildDynamicGraph() turns an ad hoc step list directly into a running
// LangGraph graph with NO predefined workflow id required (the graph id
// used here is never registered in workflowRegistry), reuses the exact
// same node-wrapping/dependency-gating/reflection-wiring machinery
// buildWorkflowGraph gives every registered workflow, and gives genuine
// parallel execution for independent branches with zero extra plumbing.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import {
  buildDynamicGraph,
  registerGraphNode,
  unregisterGraphNode,
  type GraphStepLike,
} from '../src/ai/langgraph/graph-builder.js';
import { emptyApprovalState, type GraphState } from '../src/ai/langgraph/state.js';
import { redis } from '../src/cache/redis.js';

const GRAPH_ID = 'dyn-graph-verify-not-a-registered-workflow';
const AGENT_UP = 'dyn-graph-upstream';
const AGENT_LEFT = 'dyn-graph-left';
const AGENT_RIGHT = 'dyn-graph-right';
const AGENT_JOIN = 'dyn-graph-join';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const timings: Record<string, { start: number; finish: number }> = {};
  let joinCalls = 0;
  let failCalls = 0;

  orchestratorAgentRegistry.register({
    id: AGENT_UP,
    description: 'upstream',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1, resourceCount: 1 }),
  });
  orchestratorAgentRegistry.register({
    id: AGENT_LEFT,
    description: 'left branch, sleeps 150ms',
    canHandle: () => true,
    execute: async () => {
      const start = Date.now();
      await sleep(150);
      timings.left = { start, finish: Date.now() };
      return { confidenceScore: 1 };
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_RIGHT,
    description: 'right branch, sleeps 150ms',
    canHandle: () => true,
    execute: async () => {
      const start = Date.now();
      await sleep(150);
      timings.right = { start, finish: Date.now() };
      return { confidenceScore: 1 };
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_JOIN,
    description: 'join, depends on both branches',
    canHandle: () => true,
    execute: () => {
      joinCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });

  registerGraphNode(
    AGENT_UP,
    makeAgentNode({
      stateKey: 'discovery',
      stepId: 'upstream',
      agentId: AGENT_UP,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_LEFT,
    makeAgentNode({
      stateKey: 'risk',
      stepId: 'left',
      agentId: AGENT_LEFT,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_RIGHT,
    makeAgentNode({
      stateKey: 'compliance',
      stepId: 'right',
      agentId: AGENT_RIGHT,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_JOIN,
    makeAgentNode({
      stateKey: 'recommendations',
      stepId: 'join',
      agentId: AGENT_JOIN,
      buildInput: () => ({}),
    }),
  );

  function initialState(): Partial<GraphState> {
    return {
      goal: 'dynamic graph verify',
      intent: GRAPH_ID,
      asset: [],
      connectedAccounts: [],
      memory: { conversationTurns: [], session: {} },
      approval: emptyApprovalState(),
      metadata: { executionId: 'dyn-exec-1', planId: 'dyn-plan-1', workflowId: GRAPH_ID },
    };
  }

  try {
    console.log('1. no predefined workflow id required');
    check('graph id used here is not a registered workflow', !workflowRegistry.has(GRAPH_ID));

    const steps: GraphStepLike[] = [
      { stepId: 'upstream', agentId: AGENT_UP },
      { stepId: 'left', agentId: AGENT_LEFT, dependsOn: ['upstream'] },
      { stepId: 'right', agentId: AGENT_RIGHT, dependsOn: ['upstream'] },
      { stepId: 'join', agentId: AGENT_JOIN, dependsOn: ['left', 'right'] },
    ];
    const compiled = buildDynamicGraph(GRAPH_ID, steps);
    check('buildDynamicGraph returns a compiled graph', typeof compiled.invoke === 'function');

    console.log('2. runs end to end, wiring into the reflection node automatically');
    const config = { configurable: { thread_id: 'dyn-graph-thread-1' } };
    const startedAtMs = Date.now();
    await compiled.invoke(initialState(), config);
    const totalMs = Date.now() - startedAtMs;
    const snapshot = await compiled.getState(config);
    const finalState = snapshot.values;

    const ranStepIds = finalState.executionTrace.map((entry) => entry.stepId);
    check(
      'all four steps ran',
      ['upstream', 'left', 'right', 'join'].every((id) => ranStepIds.includes(id)),
    );
    check('join ran exactly once', joinCalls === 1);
    check(
      'reflection ran automatically (state.reflection populated)',
      finalState.reflection !== undefined,
    );

    console.log('3. genuine parallel execution — left/right overlap in wall-clock time');
    check('both branches recorded timings', !!timings.left && !!timings.right);
    check(
      'left and right overlap (one starts before the other finishes)',
      timings.left.start < timings.right.finish && timings.right.start < timings.left.finish,
    );
    check(
      'total duration is close to one branch (~150ms), not the sum of both (~300ms)',
      totalMs < 280,
      `totalMs=${totalMs}`,
    );

    console.log('4. dependency gating — a failed upstream step blocks its dependent (SKIPPED)');
    const FAIL_AGENT = 'dyn-graph-failer';
    orchestratorAgentRegistry.register({
      id: FAIL_AGENT,
      description: 'always fails',
      canHandle: () => true,
      execute: () => Promise.reject(new Error('intentional failure for verify-dynamic-graph')),
    });
    registerGraphNode(
      FAIL_AGENT,
      makeAgentNode({
        stateKey: 'discovery',
        stepId: 'failer',
        agentId: FAIL_AGENT,
        buildInput: () => ({}),
      }),
    );
    orchestratorAgentRegistry.register({
      id: `${AGENT_JOIN}-2`,
      description: 'depends on the failer',
      canHandle: () => true,
      execute: () => {
        failCalls += 1;
        return Promise.resolve({ confidenceScore: 1 });
      },
    });
    registerGraphNode(
      `${AGENT_JOIN}-2`,
      makeAgentNode({
        stateKey: 'report',
        stepId: 'dependent',
        agentId: `${AGENT_JOIN}-2`,
        buildInput: () => ({}),
      }),
    );
    const gatedGraph = buildDynamicGraph(`${GRAPH_ID}-gated`, [
      { stepId: 'failer', agentId: FAIL_AGENT },
      { stepId: 'dependent', agentId: `${AGENT_JOIN}-2`, dependsOn: ['failer'] },
    ]);
    const gatedConfig = { configurable: { thread_id: 'dyn-graph-thread-gated' } };
    await gatedGraph.invoke(initialState(), gatedConfig);
    const gatedState = (await gatedGraph.getState(gatedConfig)).values;
    check('the dependent step never actually ran', failCalls === 0);
    check(
      'the dependent step is recorded as SKIPPED',
      gatedState.executionTrace.find((entry) => entry.stepId === 'dependent')?.status === 'SKIPPED',
    );
    unregisterGraphNode(FAIL_AGENT);
    unregisterGraphNode(`${AGENT_JOIN}-2`);
    orchestratorAgentRegistry.unregister(FAIL_AGENT);
    orchestratorAgentRegistry.unregister(`${AGENT_JOIN}-2`);
  } finally {
    unregisterGraphNode(AGENT_UP);
    unregisterGraphNode(AGENT_LEFT);
    unregisterGraphNode(AGENT_RIGHT);
    unregisterGraphNode(AGENT_JOIN);
    orchestratorAgentRegistry.unregister(AGENT_UP);
    orchestratorAgentRegistry.unregister(AGENT_LEFT);
    orchestratorAgentRegistry.unregister(AGENT_RIGHT);
    orchestratorAgentRegistry.unregister(AGENT_JOIN);
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
