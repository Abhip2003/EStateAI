// Phase 27 spec #10 — Checkpointing. Three layers: (1) GraphCheckpointStore
// itself (save/get/delete round-trip), (2) GraphExecutor persisting a
// durable snapshot after every run()/resume() call, and (3) the
// "resume after crash/restart" story — graphRegistry.invalidate()
// discards the in-process compiled graph (and with it, LangGraph's own
// in-memory MemorySaver), simulating a process restart; resume() must
// still recover correctly from the durable snapshot alone.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { approvalPolicy } from '../src/ai/approval/approval-policy.js';
import { approvalFoundation } from '../src/ai/approval/approval.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import { registerGraphNode, unregisterGraphNode } from '../src/ai/langgraph/graph-builder.js';
import { GraphCheckpointStore } from '../src/ai/langgraph/graph.checkpoint.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import { InMemoryStore } from '../src/ai/memory/index.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'lg-checkpoint-workflow';
const AGENT_A = 'lg-checkpoint-a';
const AGENT_B = 'lg-checkpoint-b';

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. GraphCheckpointStore — direct save/get/delete round-trip');
  const store = new GraphCheckpointStore(new InMemoryStore());
  const snapshot = {
    executionId: 'exec-1',
    graphId: 'graph-1',
    values: {
      goal: 'g',
      intent: 'i',
      messages: [],
      asset: [],
      connectedAccounts: [],
      discovery: undefined,
      risk: undefined,
      compliance: undefined,
      recommendations: undefined,
      report: undefined,
      knowledge: [],
      memory: { conversationTurns: [], session: {} },
      toolResults: [],
      reflection: undefined,
      approval: { requestIdByStep: {}, pendingApprovalIds: [], rejectedStepIds: [] },
      executionTrace: [],
      metadata: {},
    },
    next: [],
    pendingApprovals: [],
    updatedAt: new Date().toISOString(),
  };
  check('get() on an unknown id returns undefined', (await store.get('missing')) === undefined);
  await store.save(snapshot);
  const fetched = await store.get('exec-1');
  check('save() then get() round-trips the snapshot', fetched?.executionId === 'exec-1');
  await store.delete('exec-1');
  check('delete() removes it', (await store.get('exec-1')) === undefined);

  console.log('2. GraphExecutor persists a checkpoint after run() and after resume()');
  let aCalls = 0;
  let bCalls = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_A,
    description: 'a',
    canHandle: () => true,
    execute: () => {
      aCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_B,
    description: 'b (MANUAL)',
    canHandle: () => true,
    execute: () => {
      bCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });
  registerGraphNode(
    AGENT_A,
    makeAgentNode({ stateKey: 'discovery', stepId: 'a', agentId: AGENT_A, buildInput: () => ({}) }),
  );
  registerGraphNode(
    AGENT_B,
    makeAgentNode({ stateKey: 'risk', stepId: 'b', agentId: AGENT_B, buildInput: () => ({}) }),
  );
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'checkpoint test',
    description: 'a -> b (MANUAL)',
    steps: [
      { stepId: 'a', agentId: AGENT_A },
      { stepId: 'b', agentId: AGENT_B, dependsOn: ['a'] },
    ],
  });
  approvalPolicy.register(AGENT_A, 'NEVER');
  approvalPolicy.register(AGENT_B, 'MANUAL');

  try {
    const run1 = await graphExecutor.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
    check(
      'run() reports WAITING_FOR_APPROVAL (b is MANUAL)',
      run1.status === 'WAITING_FOR_APPROVAL',
    );
    const afterRun = await graphExecutor.getExecution(run1.executionId);
    check(
      'a durable checkpoint exists immediately after run()',
      afterRun?.status === 'WAITING_FOR_APPROVAL',
    );

    const pendingId = run1.pendingApprovalIds[0];
    await approvalFoundation.approvalEngine.decide(pendingId, 'APPROVED', {
      reviewerId: 'reviewer-1',
    });

    console.log(
      '3. resume after crash/restart — invalidate the in-process compiled graph, then resume()',
    );
    graphRegistry.invalidate(WORKFLOW_ID);
    check('aCalls is 1 before restart-resume', aCalls === 1);
    check('bCalls is 0 before restart-resume', bCalls === 0);

    const resumed = await graphExecutor.resume(run1.executionId);
    check('resume() after restart reports RESUMED', resumed.status === 'RESUMED');
    check('a was NOT re-invoked (idempotent replay)', aCalls === 1);
    check('b WAS invoked exactly once', bCalls === 1);

    // getExecution() derives status fresh from the persisted snapshot
    // alone — it has no memory of whether the last invokeAndPersist()
    // call was itself a run() or a resume(), so a since-resumed,
    // now-fully-finished execution correctly reads back as COMPLETED
    // here even though resume()'s own return value (checked above) was
    // RESUMED for that specific call.
    const afterResume = await graphExecutor.getExecution(run1.executionId);
    check(
      'the durable checkpoint reflects the finished state',
      afterResume?.status === 'COMPLETED',
    );

    console.log(
      '4. resume() on a still-pending execution after restart stays WAITING_FOR_APPROVAL',
    );
    const run2 = await graphExecutor.run({ goal: WORKFLOW_ID, user: { id: 'u2', role: 'ADMIN' } });
    check('run2 is WAITING_FOR_APPROVAL', run2.status === 'WAITING_FOR_APPROVAL');
    graphRegistry.invalidate(WORKFLOW_ID);
    const tooEarly = await graphExecutor.resume(run2.executionId);
    check(
      'resuming before a decision exists stays WAITING_FOR_APPROVAL',
      tooEarly.status === 'WAITING_FOR_APPROVAL',
    );
    check(
      'the pending approval id is preserved',
      tooEarly.pendingApprovalIds[0] === run2.pendingApprovalIds[0],
    );
  } finally {
    workflowRegistry.unregister(WORKFLOW_ID);
    graphRegistry.invalidate(WORKFLOW_ID);
    unregisterGraphNode(AGENT_A);
    unregisterGraphNode(AGENT_B);
    orchestratorAgentRegistry.unregister(AGENT_A);
    orchestratorAgentRegistry.unregister(AGENT_B);
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
