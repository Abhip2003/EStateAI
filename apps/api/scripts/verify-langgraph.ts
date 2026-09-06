// Phase 27 — LangGraph foundation checks: GraphState defaults, node
// wrapping (idempotent replay guard, NEVER-policy passthrough calling
// the real registered agent), buildWorkflowGraph() building successfully
// for every already-registered workflow (spec acceptance criterion
// "LangGraph executes all workflows"), a full GraphExecutor.run()
// round-trip with a throwaway fake-agent workflow, and a live-server
// backward-compatibility check (pre-existing AI endpoints untouched).
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { createChecker, api, registerAndLogin } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { GraphStateAnnotation, emptyApprovalState } from '../src/ai/langgraph/state.js';
import type { GraphState } from '../src/ai/langgraph/state.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import {
  buildWorkflowGraph,
  countMaxParallelBranches,
  registerGraphNode,
  unregisterGraphNode,
} from '../src/ai/langgraph/graph-builder.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'lg-foundation-workflow';
const AGENT_ID = 'lg-foundation-agent';

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. GraphState defaults');
  const noopGraph = new StateGraph(GraphStateAnnotation)
    .addNode('noop', () => Promise.resolve({}))
    .addEdge(START, 'noop')
    .addEdge('noop', END)
    .compile({ checkpointer: new MemorySaver() });
  const defaultsThreadId = { configurable: { thread_id: 'defaults-check' } };
  await noopGraph.invoke({}, defaultsThreadId);
  const defaultState = (await noopGraph.getState(defaultsThreadId)).values as GraphState;
  check('goal channel defaults to an empty string', defaultState.goal === '');
  check(
    'executionTrace channel defaults to []',
    Array.isArray(defaultState.executionTrace) && defaultState.executionTrace.length === 0,
  );
  check(
    'approval channel defaults to emptyApprovalState()',
    JSON.stringify(defaultState.approval) === JSON.stringify(emptyApprovalState()),
  );

  console.log('2. buildWorkflowGraph builds for every already-registered workflow');
  for (const definition of workflowRegistry.list()) {
    try {
      buildWorkflowGraph(definition);
      check(`builds graph for "${definition.id}"`, true);
    } catch (err) {
      check(
        `builds graph for "${definition.id}"`,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  check(
    'countMaxParallelBranches("full-security-analysis") is 2 (risk||compliance)',
    countMaxParallelBranches(workflowRegistry.get('full-security-analysis')) === 2,
  );
  check(
    'countMaxParallelBranches("risk-only") is 1 (no parallel branch)',
    countMaxParallelBranches(workflowRegistry.get('risk-only')) === 1,
  );

  console.log('3. makeAgentNode — idempotent replay guard + NEVER-policy passthrough');
  let calls = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_ID,
    description: 'fake agent for Phase 27 foundation checks',
    canHandle: () => true,
    execute: () => {
      calls += 1;
      return Promise.resolve({ confidenceScore: 1, ran: true });
    },
  });
  const node = makeAgentNode({
    stateKey: 'discovery',
    stepId: 'discovery',
    agentId: AGENT_ID,
    buildInput: () => ({}),
  });
  function testState(
    discovery: unknown,
    executionTrace: Parameters<typeof node>[0]['executionTrace'] = [],
  ): Parameters<typeof node>[0] {
    return {
      goal: 'g',
      intent: 'i',
      messages: [],
      asset: [],
      connectedAccounts: [],
      discovery,
      risk: undefined,
      compliance: undefined,
      recommendations: undefined,
      report: undefined,
      knowledge: [],
      memory: { conversationTurns: [], session: {} },
      toolResults: [],
      reflection: undefined,
      approval: emptyApprovalState(),
      executionTrace,
      metadata: { executionId: 'ex1', planId: 'p1', workflowId: WORKFLOW_ID },
    };
  }
  const patch = await node(testState(undefined));
  check('node calls the real registered agent exactly once', calls === 1);
  check(
    'node returns the agent output under its stateKey',
    (patch as { discovery?: unknown }).discovery !== undefined,
  );

  const noOpPatch = await node(
    testState({ already: 'set' }, [
      {
        stepId: 'discovery',
        agentId: AGENT_ID,
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
      },
    ]),
  );
  check(
    'node no-ops (idempotent replay guard) once executionTrace already has a terminal entry for this step',
    calls === 1,
  );
  check('no-op returns an empty patch', Object.keys(noOpPatch).length === 0);

  await node(
    testState(undefined, [
      {
        stepId: 'discovery',
        agentId: AGENT_ID,
        status: 'FAILED',
        timestamp: new Date().toISOString(),
      },
    ]),
  );
  check(
    'node also no-ops on a prior FAILED attempt, not just SUCCESS (replay-safety fix — see verify-recovery.ts)',
    calls === 1,
  );

  console.log('4. GraphExecutor.run() end-to-end with a throwaway fake-agent workflow');
  registerGraphNode(AGENT_ID, node);
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Phase 27 foundation workflow',
    description: 'single-step, no gating',
    steps: [{ stepId: 'discovery', agentId: AGENT_ID }],
  });
  const result = await graphExecutor.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
  check('run() reports COMPLETED', result.status === 'COMPLETED');
  check('run() graphId matches the workflow id', result.graphId === WORKFLOW_ID);
  check(
    'run() state.discovery carries the agent output',
    (result.state.discovery as { ran?: boolean })?.ran === true,
  );

  console.log('5. checkpoint + state readback');
  const fetched = await graphExecutor.getExecution(result.executionId);
  check('getExecution() returns the same status', fetched?.status === 'COMPLETED');
  const fetchedState = await graphExecutor.getState(result.executionId);
  check('getState() returns the persisted GraphState', fetchedState?.goal === WORKFLOW_ID);

  console.log('6. live server — pre-existing AI endpoints still respond (backward compatibility)');
  const user = await registerAndLogin(`verify-langgraph-${Date.now()}@example.test`);
  const orchestratorRes = await api('POST', '/ai/orchestrator/execute', user.accessToken, {
    intent: 'risk-only',
  });
  check(
    'POST /ai/orchestrator/execute still 200',
    orchestratorRes.status === 200,
    `got ${orchestratorRes.status}`,
  );
  const plannerRes = await api('POST', '/ai/planner/plan', user.accessToken, {
    goal: 'risk analysis',
  });
  check('POST /ai/planner/plan still 200', plannerRes.status === 200, `got ${plannerRes.status}`);

  workflowRegistry.unregister(WORKFLOW_ID);
  graphRegistry.invalidate(WORKFLOW_ID);
  unregisterGraphNode(AGENT_ID);
  orchestratorAgentRegistry.unregister(AGENT_ID);

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
