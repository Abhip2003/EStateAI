// Phase 27 spec #9 — HITL, graph-native. Reuses the Phase 26 Approval
// Engine verbatim (ai/approval/approval.js) but pauses/resumes via
// LangGraph's own `interrupt()`/`Command` primitives instead of
// HitlOrchestrator's condition-based gating: approve -> resume runs the
// gated step and its dependents without restarting completed nodes;
// reject -> resume never runs the gated step or its dependents; an
// approval carrying an editedOutput injects that value directly without
// invoking the agent at all.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { approvalPolicy } from '../src/ai/approval/approval-policy.js';
import { approvalFoundation } from '../src/ai/approval/approval.js';
import { makeAgentNode } from '../src/ai/langgraph/nodes.js';
import { registerGraphNode, unregisterGraphNode } from '../src/ai/langgraph/graph-builder.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'lg-hitl-workflow';
const AGENT_UPSTREAM = 'lg-hitl-upstream';
const AGENT_GATED = 'lg-hitl-gated';
const AGENT_DOWNSTREAM = 'lg-hitl-downstream';

function register(): {
  upstreamCalls: () => number;
  gatedCalls: () => number;
  downstreamCalls: () => number;
} {
  let upstreamCalls = 0;
  let gatedCalls = 0;
  let downstreamCalls = 0;

  orchestratorAgentRegistry.register({
    id: AGENT_UPSTREAM,
    description: 'upstream, never gated',
    canHandle: () => true,
    execute: () => {
      upstreamCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_GATED,
    description: 'MANUAL-gated',
    canHandle: () => true,
    execute: () => {
      gatedCalls += 1;
      return Promise.resolve({ confidenceScore: 1, ran: 'gated-agent' });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_DOWNSTREAM,
    description: 'depends on the gated step',
    canHandle: () => true,
    execute: () => {
      downstreamCalls += 1;
      return Promise.resolve({ confidenceScore: 1 });
    },
  });

  registerGraphNode(
    AGENT_UPSTREAM,
    makeAgentNode({
      stateKey: 'discovery',
      stepId: 'upstream',
      agentId: AGENT_UPSTREAM,
      buildInput: () => ({}),
    }),
  );
  registerGraphNode(
    AGENT_GATED,
    makeAgentNode({
      stateKey: 'risk',
      stepId: 'gated',
      agentId: AGENT_GATED,
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
    name: 'Phase 27 HITL workflow',
    description: 'upstream -> gated (MANUAL) -> downstream',
    steps: [
      { stepId: 'upstream', agentId: AGENT_UPSTREAM },
      { stepId: 'gated', agentId: AGENT_GATED, dependsOn: ['upstream'] },
      { stepId: 'downstream', agentId: AGENT_DOWNSTREAM, dependsOn: ['gated'] },
    ],
  });
  approvalPolicy.register(AGENT_GATED, 'MANUAL');

  return {
    upstreamCalls: () => upstreamCalls,
    gatedCalls: () => gatedCalls,
    downstreamCalls: () => downstreamCalls,
  };
}

function cleanup(): void {
  workflowRegistry.unregister(WORKFLOW_ID);
  graphRegistry.invalidate(WORKFLOW_ID);
  unregisterGraphNode(AGENT_UPSTREAM);
  unregisterGraphNode(AGENT_GATED);
  unregisterGraphNode(AGENT_DOWNSTREAM);
  orchestratorAgentRegistry.unregister(AGENT_UPSTREAM);
  orchestratorAgentRegistry.unregister(AGENT_GATED);
  orchestratorAgentRegistry.unregister(AGENT_DOWNSTREAM);
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. run() pauses at WAITING_FOR_APPROVAL on the MANUAL-gated step');
  {
    const calls = register();
    try {
      const first = await graphExecutor.run({
        goal: WORKFLOW_ID,
        user: { id: 'u1', role: 'ADMIN' },
      });
      check('status is WAITING_FOR_APPROVAL', first.status === 'WAITING_FOR_APPROVAL');
      check('exactly one pending approval id', first.pendingApprovalIds.length === 1);
      check('upstream ran', calls.upstreamCalls() === 1);
      check('gated agent was never invoked', calls.gatedCalls() === 0);
      check('downstream agent was never invoked', calls.downstreamCalls() === 0);
      check('state.risk (gated step slot) is still undefined', first.state.risk === undefined);

      console.log('2. approve -> resume() runs the gated step and its dependent exactly once');
      const decided = await approvalFoundation.approvalEngine.decide(
        first.pendingApprovalIds[0],
        'APPROVED',
        {
          reviewerId: 'reviewer-1',
          reason: 'looks fine',
        },
      );
      check('decision recorded as APPROVED', decided.status === 'APPROVED');
      const resumed = await graphExecutor.resume(first.executionId);
      check('status is RESUMED', resumed.status === 'RESUMED');
      check('gated agent ran exactly once', calls.gatedCalls() === 1);
      check('downstream agent ran exactly once', calls.downstreamCalls() === 1);
      check('upstream was NOT re-invoked', calls.upstreamCalls() === 1);
      check('no pending approvals remain', resumed.pendingApprovalIds.length === 0);
    } finally {
      cleanup();
    }
  }

  console.log('3. reject -> resume() never runs the gated step or its dependent');
  {
    const calls = register();
    try {
      const first = await graphExecutor.run({
        goal: WORKFLOW_ID,
        user: { id: 'u2', role: 'ADMIN' },
      });
      const rejected = await approvalFoundation.approvalEngine.decide(
        first.pendingApprovalIds[0],
        'REJECTED',
        {
          reviewerId: 'reviewer-1',
          reason: 'not safe',
        },
      );
      check('decision recorded as REJECTED', rejected.status === 'REJECTED');
      const resumed = await graphExecutor.resume(first.executionId);
      check('status is REJECTED', resumed.status === 'REJECTED');
      check('gated agent was never invoked', calls.gatedCalls() === 0);
      check('downstream agent was never invoked', calls.downstreamCalls() === 0);
      check(
        'the rejected stepId is recorded',
        resumed.state.approval.rejectedStepIds.includes('gated'),
      );
    } finally {
      cleanup();
    }
  }

  console.log('4. approve with editedOutput -> resume() injects it without invoking the agent');
  {
    const calls = register();
    try {
      const first = await graphExecutor.run({
        goal: WORKFLOW_ID,
        user: { id: 'u3', role: 'ADMIN' },
      });
      const editedOutput = { confidenceScore: 1, ran: 'reviewer-edit' };
      await approvalFoundation.approvalEngine.decide(first.pendingApprovalIds[0], 'APPROVED', {
        reviewerId: 'reviewer-1',
        editedOutput,
      });
      const resumed = await graphExecutor.resume(first.executionId);
      check('status is RESUMED', resumed.status === 'RESUMED');
      check('gated agent was NEVER invoked (edited output used instead)', calls.gatedCalls() === 0);
      check(
        'state.risk carries the reviewer-supplied output',
        JSON.stringify(resumed.state.risk) === JSON.stringify(editedOutput),
      );
      check('downstream still ran exactly once', calls.downstreamCalls() === 1);
    } finally {
      cleanup();
    }
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
