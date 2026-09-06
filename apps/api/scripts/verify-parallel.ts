// Phase 27 spec #6 — Parallel Execution. buildWorkflowGraph() gives real
// LangGraph concurrency for free from a WorkflowDefinition's own
// dependency shape (two steps depending on the same upstream step run in
// the same Pregel superstep) — this verifies it's genuine wall-clock
// concurrency, not sequential-but-fast, using two fake agents that each
// sleep and record their own start/finish timestamps.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import {
  countMaxParallelBranches,
  registerGraphNode,
  unregisterGraphNode,
} from '../src/ai/langgraph/graph-builder.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'lg-parallel-workflow';
const AGENT_UP = 'lg-parallel-upstream';
const AGENT_LEFT = 'lg-parallel-left';
const AGENT_RIGHT = 'lg-parallel-right';
const AGENT_JOIN = 'lg-parallel-join';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const timings: Record<string, { start: number; finish: number }> = {};
  let joinCalls = 0;

  orchestratorAgentRegistry.register({
    id: AGENT_UP,
    description: 'upstream',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1 }),
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

  const definition = {
    id: WORKFLOW_ID,
    name: 'Phase 27 parallel-branch workflow',
    description: 'upstream -> (left || right) -> join',
    steps: [
      { stepId: 'upstream', agentId: AGENT_UP },
      { stepId: 'left', agentId: AGENT_LEFT, dependsOn: ['upstream'] },
      { stepId: 'right', agentId: AGENT_RIGHT, dependsOn: ['upstream'] },
      { stepId: 'join', agentId: AGENT_JOIN, dependsOn: ['left', 'right'] },
    ],
  };
  workflowRegistry.register(definition);

  try {
    console.log('1. countMaxParallelBranches — structural metric');
    check('widest wave is 2 (left, right)', countMaxParallelBranches(definition) === 2);

    console.log('2. real concurrent execution — left/right overlap in wall-clock time');
    const startedAtMs = Date.now();
    const result = await graphExecutor.run({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });
    const totalMs = Date.now() - startedAtMs;

    check('run() reports COMPLETED', result.status === 'COMPLETED');
    check('join ran exactly once', joinCalls === 1);
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

    const steps = result.state.executionTrace.map((entry) => entry.stepId);
    check(
      'all four steps ran',
      ['upstream', 'left', 'right', 'join'].every((id) => steps.includes(id)),
    );
  } finally {
    workflowRegistry.unregister(WORKFLOW_ID);
    graphRegistry.invalidate(WORKFLOW_ID);
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
