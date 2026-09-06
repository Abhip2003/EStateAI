// Phase 26 — HitlOrchestrator unit checks (pause on a MANUAL step,
// approve -> resume, reject -> resume) plus a live-server HTTP
// backward-compatibility check. In-process portion uses InMemoryStore
// for every HITL store and a throwaway workflow/fake agents (same
// convention as verify-retry.ts/verify-planning.ts's Part B) — no real
// agent's ApprovalPolicy registration is touched.
import { createChecker, api, registerAndLogin } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { PlanStore } from '../src/ai/planner/plan-store.js';
import { ApprovalStore } from '../src/ai/approval/approval-store.js';
import { ApprovalEngine } from '../src/ai/approval/approval-engine.js';
import { PausedExecutionStore } from '../src/ai/approval/paused-execution.store.js';
import { HitlOrchestrator } from '../src/ai/approval/hitl-orchestrator.js';
import { approvalPolicy } from '../src/ai/approval/approval-policy.js';
import { InMemoryStore } from '../src/ai/memory/index.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'hitl-test-workflow';
const AGENT_APPROVE = 'hitl-agent-approve-me';
const AGENT_AUTO = 'hitl-agent-auto-runs';
const AGENT_DOWNSTREAM = 'hitl-agent-downstream';

function buildHitlOrchestrator(): {
  orchestrator: HitlOrchestrator;
  approvalEngine: ApprovalEngine;
} {
  const planStore = new PlanStore(new InMemoryStore());
  const approvalEngine = new ApprovalEngine(new ApprovalStore(new InMemoryStore()));
  const pausedExecutionStore = new PausedExecutionStore(new InMemoryStore());
  const orchestrator = new HitlOrchestrator(planStore, approvalEngine, pausedExecutionStore);
  return { orchestrator, approvalEngine };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('0. setup — throwaway workflow + fake agents + MANUAL/AUTO policy registration');
  let downstreamCalls = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_APPROVE,
    description: 'fake agent gated MANUAL',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1, didRun: true }),
  });
  orchestratorAgentRegistry.register({
    id: AGENT_AUTO,
    description: 'fake agent, no gating',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1, ranWithoutApproval: true }),
  });
  orchestratorAgentRegistry.register({
    id: AGENT_DOWNSTREAM,
    description: 'fake agent depending on the gated step',
    canHandle: () => true,
    execute: () => {
      downstreamCalls += 1;
      return Promise.resolve({ confidenceScore: 1, downstreamRan: true });
    },
  });
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'HITL Test Workflow',
    description: 'auto -> gated (MANUAL) -> downstream (depends on gated)',
    steps: [
      { stepId: 'auto-step', agentId: AGENT_AUTO },
      { stepId: 'gated-step', agentId: AGENT_APPROVE },
      { stepId: 'downstream-step', agentId: AGENT_DOWNSTREAM, dependsOn: ['gated-step'] },
    ],
  });
  approvalPolicy.register(AGENT_APPROVE, 'MANUAL');

  try {
    console.log('1. run() — a plan with a MANUAL step pauses at WAITING_FOR_APPROVAL');
    const { orchestrator, approvalEngine } = buildHitlOrchestrator();
    const runResult = await orchestrator.run({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });
    check(
      'status is WAITING_FOR_APPROVAL',
      runResult.status === 'WAITING_FOR_APPROVAL',
      runResult.status,
    );
    check(
      'auto-step already ran (no gate)',
      runResult.steps.some((s) => s.stepId === 'auto-step' && s.status === 'SUCCESS'),
    );
    check(
      'gated-step did not run yet (agent never invoked)',
      !runResult.steps.some((s) => s.stepId === 'gated-step'),
    );
    check(
      'downstream-step is SKIPPED, not attempted (depends on the still-gated step)',
      runResult.steps.find((s) => s.stepId === 'downstream-step')?.status === 'SKIPPED',
    );
    check('downstream agent was never actually invoked', downstreamCalls === 0);
    check('exactly one pending approval id', runResult.pendingApprovalIds.length === 1);

    console.log('2. approve -> resume runs the gated step and its dependent');
    const [pendingId] = runResult.pendingApprovalIds;
    const approved = await approvalEngine.decide(pendingId, 'APPROVED', {
      reviewerId: 'reviewer-1',
      reason: 'looks fine',
    });
    check('decision recorded as APPROVED', approved.status === 'APPROVED');
    const resumed = await orchestrator.resume(runResult.executionId);
    check(
      'resumed status is RESUMED (clean completion)',
      resumed.status === 'RESUMED',
      resumed.status,
    );
    check(
      'gated-step now SUCCEEDED',
      resumed.steps.find((s) => s.stepId === 'gated-step')?.status === 'SUCCESS',
    );
    check(
      'downstream-step now SUCCEEDED (its dependency cleared)',
      resumed.steps.find((s) => s.stepId === 'downstream-step')?.status === 'SUCCESS',
    );
    check('downstream agent was invoked exactly once', downstreamCalls === 1);
    check('no pending approvals remain', resumed.pendingApprovalIds.length === 0);

    console.log('3. reject -> resume: a rejected step and its dependent never run');
    downstreamCalls = 0;
    const { orchestrator: orchestrator2, approvalEngine: approvalEngine2 } =
      buildHitlOrchestrator();
    const runResult2 = await orchestrator2.run({
      goal: WORKFLOW_ID,
      user: { id: 'u1', role: 'ADMIN' },
    });
    const [pendingId2] = runResult2.pendingApprovalIds;
    await approvalEngine2.decide(pendingId2, 'REJECTED', {
      reviewerId: 'reviewer-2',
      reason: 'not approved',
    });
    const resumed2 = await orchestrator2.resume(runResult2.executionId);
    check('resumed status is REJECTED', resumed2.status === 'REJECTED', resumed2.status);
    check(
      'gated-step never ran (rejected, agent never invoked)',
      !resumed2.steps.some((s) => s.stepId === 'gated-step'),
    );
    check(
      'downstream-step is SKIPPED, not attempted (its dependency was rejected)',
      resumed2.steps.find((s) => s.stepId === 'downstream-step')?.status === 'SKIPPED',
    );
    check('downstream agent was never invoked in the rejected branch', downstreamCalls === 0);
  } finally {
    orchestratorAgentRegistry.unregister(AGENT_APPROVE);
    orchestratorAgentRegistry.unregister(AGENT_AUTO);
    orchestratorAgentRegistry.unregister(AGENT_DOWNSTREAM);
    workflowRegistry.unregister(WORKFLOW_ID);
  }

  console.log('4. HTTP backward compatibility — existing planner/orchestrator routes unaffected');
  const owner = await registerAndLogin(`verify-hitl-owner-${Date.now()}@example.test`);
  const plannerRes = await api('POST', '/ai/planner/plan', owner.accessToken, {
    goal: 'assess risk for this account',
  });
  check(
    'POST /ai/planner/plan (Phase 25, ungated) still returns 200',
    plannerRes.status === 200,
    `${plannerRes.status}`,
  );
  const orchestratorRes = await api('POST', '/ai/orchestrator/execute', owner.accessToken, {
    intent: 'assess risk for this account',
  });
  check(
    'POST /ai/orchestrator/execute (Phase 17, ungated) still returns 200',
    orchestratorRes.status === 200,
    `${orchestratorRes.status}`,
  );

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll HITL checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
