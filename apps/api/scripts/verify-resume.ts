// Phase 26 — Resume semantics unit checks: multi-round resume (two
// independent MANUAL steps decided one at a time), "already-succeeded
// steps are never re-invoked" (the literal spec #4 requirement), reviewer
// output editing (spec #5's "edit recommendation"), and cancel().
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { PlanStore } from '../src/ai/planner/plan-store.js';
import { ApprovalStore } from '../src/ai/approval/approval-store.js';
import { ApprovalEngine } from '../src/ai/approval/approval-engine.js';
import { PausedExecutionStore } from '../src/ai/approval/paused-execution.store.js';
import { HitlOrchestrator } from '../src/ai/approval/hitl-orchestrator.js';
import { approvalPolicy } from '../src/ai/approval/approval-policy.js';
import { ApprovalError } from '../src/ai/approval/approval-error.js';
import { InMemoryStore } from '../src/ai/memory/index.js';
import { redis } from '../src/cache/redis.js';

const WORKFLOW_ID = 'resume-test-workflow';
const AGENT_A = 'resume-agent-a';
const AGENT_B = 'resume-agent-b';
const AGENT_JOIN = 'resume-agent-join';

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

  let callsA = 0;
  let callsB = 0;
  let callsJoin = 0;
  orchestratorAgentRegistry.register({
    id: AGENT_A,
    description: 'fake agent A, gated MANUAL',
    canHandle: () => true,
    execute: () => {
      callsA += 1;
      return Promise.resolve({ confidenceScore: 1, from: 'A' });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_B,
    description: 'fake agent B, gated MANUAL',
    canHandle: () => true,
    execute: () => {
      callsB += 1;
      return Promise.resolve({ confidenceScore: 1, from: 'B' });
    },
  });
  orchestratorAgentRegistry.register({
    id: AGENT_JOIN,
    description: 'fake agent depending on both A and B',
    canHandle: () => true,
    execute: () => {
      callsJoin += 1;
      return Promise.resolve({ confidenceScore: 1, joined: true });
    },
  });
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Resume Test Workflow',
    description: 'a (MANUAL) + b (MANUAL) -> join (depends on both)',
    steps: [
      { stepId: 'a', agentId: AGENT_A },
      { stepId: 'b', agentId: AGENT_B },
      { stepId: 'join', agentId: AGENT_JOIN, dependsOn: ['a', 'b'] },
    ],
  });
  approvalPolicy.register(AGENT_A, 'MANUAL');
  approvalPolicy.register(AGENT_B, 'MANUAL');

  try {
    console.log('1. run() — both a and b gate, join never attempted');
    const { orchestrator, approvalEngine } = buildHitlOrchestrator();
    const run = await orchestrator.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
    check('status WAITING_FOR_APPROVAL', run.status === 'WAITING_FOR_APPROVAL', run.status);
    check('two pending approvals', run.pendingApprovalIds.length === 2);
    check('neither a nor b ran', callsA === 0 && callsB === 0);

    const pending = await Promise.all(run.pendingApprovalIds.map((id) => approvalEngine.get(id)));
    const aRequest = pending.find((r) => r?.stepId === 'a')!;
    const bRequest = pending.find((r) => r?.stepId === 'b')!;

    console.log('2. approve only "a" -> resume: still WAITING_FOR_APPROVAL (b still pending)');
    await approvalEngine.decide(aRequest.id, 'APPROVED', { reviewerId: 'r1' });
    const round2 = await orchestrator.resume(run.executionId);
    check(
      'status still WAITING_FOR_APPROVAL',
      round2.status === 'WAITING_FOR_APPROVAL',
      round2.status,
    );
    check('a ran exactly once', callsA === 1);
    check('b has still never run', callsB === 0);
    check('join has still never run (b not yet decided)', callsJoin === 0);
    check('one pending approval remains (b)', round2.pendingApprovalIds.length === 1);

    console.log('3. resume again without deciding anything -> "a" is NOT re-invoked');
    const round2b = await orchestrator.resume(run.executionId);
    check('a was NOT called a second time (already succeeded)', callsA === 1);
    check('status unchanged (still waiting on b)', round2b.status === 'WAITING_FOR_APPROVAL');

    console.log('4. approve "b" with an edited output -> resume: join runs, b agent never invoked');
    await approvalEngine.decide(bRequest.id, 'APPROVED', {
      reviewerId: 'r2',
      editedOutput: { from: 'reviewer-edit', confidenceScore: 1 },
    });
    const round3 = await orchestrator.resume(run.executionId);
    check('status is RESUMED (clean completion)', round3.status === 'RESUMED', round3.status);
    check('b agent itself was never invoked (edited output used instead)', callsB === 0);
    const bStep = round3.steps.find((s) => s.stepId === 'b');
    check(
      'b step recorded as SUCCESS with the reviewer-edited output',
      bStep?.status === 'SUCCESS' && (bStep.output as { from: string })?.from === 'reviewer-edit',
    );
    check('join ran exactly once, after both a and b resolved', callsJoin === 1);
    check(
      'a still shows its original (non-edited) output',
      (round3.steps.find((s) => s.stepId === 'a')?.output as { from: string })?.from === 'A',
    );

    console.log('5. cancel() — a fresh WAITING_FOR_APPROVAL execution can be cancelled');
    const { orchestrator: orchestrator2 } = buildHitlOrchestrator();
    const run2 = await orchestrator2.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
    check('second run also pauses', run2.status === 'WAITING_FOR_APPROVAL');
    const cancelled = await orchestrator2.cancel(run2.executionId);
    check('cancel() reports CANCELLED', cancelled.status === 'CANCELLED');

    let resumeAfterCancelThrew = false;
    try {
      await orchestrator2.resume(run2.executionId);
    } catch (err) {
      resumeAfterCancelThrew = err instanceof ApprovalError;
    }
    check(
      'resuming a cancelled execution throws (paused state was dropped)',
      resumeAfterCancelThrew,
    );
  } finally {
    orchestratorAgentRegistry.unregister(AGENT_A);
    orchestratorAgentRegistry.unregister(AGENT_B);
    orchestratorAgentRegistry.unregister(AGENT_JOIN);
    workflowRegistry.unregister(WORKFLOW_ID);
  }

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll resume checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
