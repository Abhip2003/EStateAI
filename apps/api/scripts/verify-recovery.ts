// Phase 27 spec #10/#12 — dedicated crash/restart recovery + error-path
// checks that don't fit verify-checkpoint.ts's happier-path coverage:
// resuming an unknown execution, resuming a fully-COMPLETED execution
// twice in a row after a restart, and a mid-chain FAILURE correctly
// blocking (not just skipping) its dependent after a restart.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { approvalPolicy } from '../src/ai/approval/approval-policy.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import { registerGraphNode, unregisterGraphNode } from '../src/ai/langgraph/graph-builder.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import { GraphError } from '../src/ai/langgraph/graph-error.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'lg-recovery-workflow';
const AGENT_OK = 'lg-recovery-ok';
const AGENT_FAILS = 'lg-recovery-fails';
const AGENT_DOWNSTREAM = 'lg-recovery-downstream';

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. resume() on an unknown executionId throws GraphError');
  try {
    await graphExecutor.resume('gexec-does-not-exist');
    check('resume() throws for an unknown execution', false, 'did not throw');
  } catch (err) {
    check('resume() throws GraphError for an unknown execution', err instanceof GraphError);
  }

  console.log('2. getExecution()/getState() on an unknown executionId return undefined');
  check(
    'getExecution() returns undefined',
    (await graphExecutor.getExecution('gexec-nope')) === undefined,
  );
  check('getState() returns undefined', (await graphExecutor.getState('gexec-nope')) === undefined);

  let okCalls = 0;
  let failCalls = 0;
  let downstreamCalls = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_OK,
    description: 'ok',
    canHandle: () => true,
    execute: () => {
      okCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_FAILS,
    description: 'always fails',
    canHandle: () => true,
    execute: () => {
      failCalls += 1;
      return Promise.reject(new Error('synthetic failure'));
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_DOWNSTREAM,
    description: 'depends on the failing step',
    canHandle: () => true,
    execute: () => {
      downstreamCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });
  registerGraphNode(
    AGENT_OK,
    makeAgentNode({
      stateKey: 'discovery',
      stepId: 'ok',
      agentId: AGENT_OK,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_FAILS,
    makeAgentNode({
      stateKey: 'risk',
      stepId: 'fails',
      agentId: AGENT_FAILS,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_DOWNSTREAM,
    makeAgentNode({
      stateKey: 'compliance',
      stepId: 'downstream',
      agentId: AGENT_DOWNSTREAM,
      buildInput: () => ({}),
    }),
  );
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Phase 27 recovery workflow',
    description: 'ok -> fails -> downstream (depends on fails)',
    steps: [
      { stepId: 'ok', agentId: AGENT_OK },
      { stepId: 'fails', agentId: AGENT_FAILS, dependsOn: ['ok'] },
      { stepId: 'downstream', agentId: AGENT_DOWNSTREAM, dependsOn: ['fails'] },
    ],
  });
  approvalPolicy.register(AGENT_OK, 'NEVER');
  approvalPolicy.register(AGENT_FAILS, 'NEVER');
  approvalPolicy.register(AGENT_DOWNSTREAM, 'NEVER');

  try {
    console.log('3. a mid-chain FAILURE blocks its dependent, and survives a restart');
    const run1 = await graphExecutor.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
    check('status is PARTIAL (ok succeeded, fails failed)', run1.status === 'PARTIAL');
    const steps1 = run1.state.executionTrace.map((entry) => `${entry.stepId}:${entry.status}`);
    check('ok:SUCCESS recorded', steps1.includes('ok:SUCCESS'));
    check('fails:FAILED recorded', steps1.includes('fails:FAILED'));
    check(
      'downstream:SKIPPED recorded (blocked by the failed dependency)',
      steps1.includes('downstream:SKIPPED'),
    );
    check('downstream agent was never actually invoked', downstreamCalls === 0);

    console.log(
      '--- simulating a restart, then resuming the already-finished, failed execution ---',
    );
    graphRegistry.invalidate(WORKFLOW_ID);
    const resumed1 = await graphExecutor.resume(run1.executionId);
    check(
      'resume() after restart reports the same terminal outcome (PARTIAL)',
      resumed1.status === 'PARTIAL',
    );
    check('ok was NOT re-invoked', okCalls === 1);
    check(
      'fails was NOT re-invoked (a FAILED step is terminal, not retried on replay)',
      failCalls === 1,
    );
    check('downstream still never ran', downstreamCalls === 0);

    console.log(
      '4. resuming a fully-COMPLETED execution twice after a restart is a safe no-op both times',
    );
    orchestratorAgentRegistry.unregister(AGENT_FAILS);
    orchestratorAgentRegistry.register({
      id: AGENT_FAILS,
      description: 'now succeeds',
      canHandle: () => true,
      execute: () => {
        failCalls += 1;
        return Promise.resolve({ confidenceScore: 1 });
      },
    });
    const run2 = await graphExecutor.run({ goal: WORKFLOW_ID, user: { id: 'u2', role: 'ADMIN' } });
    check('run2 status is COMPLETED', run2.status === 'COMPLETED');
    const okCallsAfterRun2 = okCalls;
    const downstreamCallsAfterRun2 = downstreamCalls;

    graphRegistry.invalidate(WORKFLOW_ID);
    const firstReplay = await graphExecutor.resume(run2.executionId);
    check('first post-restart resume() reports RESUMED', firstReplay.status === 'RESUMED');
    check(
      'no agent was re-invoked on the first replay',
      okCalls === okCallsAfterRun2 && downstreamCalls === downstreamCallsAfterRun2,
    );

    graphRegistry.invalidate(WORKFLOW_ID);
    const secondReplay = await graphExecutor.resume(run2.executionId);
    check('second post-restart resume() also reports RESUMED', secondReplay.status === 'RESUMED');
    check(
      'no agent was re-invoked on the second replay either',
      okCalls === okCallsAfterRun2 && downstreamCalls === downstreamCallsAfterRun2,
    );
  } finally {
    workflowRegistry.unregister(WORKFLOW_ID);
    graphRegistry.invalidate(WORKFLOW_ID);
    unregisterGraphNode(AGENT_OK);
    unregisterGraphNode(AGENT_FAILS);
    unregisterGraphNode(AGENT_DOWNSTREAM);
    orchestratorAgentRegistry.unregister(AGENT_OK);
    orchestratorAgentRegistry.unregister(AGENT_FAILS);
    orchestratorAgentRegistry.unregister(AGENT_DOWNSTREAM);
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
