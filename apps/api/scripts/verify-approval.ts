// Phase 26 — Approval Engine unit checks. Pure in-process: ApprovalPolicy/
// ApprovalStore/ApprovalEngine have no dependency on redis, WorkflowEngine,
// or any agent — this runs against InMemoryStore only, no server needed.
import { createChecker } from './lib/verify-helpers.js';
import { ApprovalPolicy } from '../src/ai/approval/approval-policy.js';
import { ApprovalStore } from '../src/ai/approval/approval-store.js';
import { ApprovalEngine } from '../src/ai/approval/approval-engine.js';
import { ApprovalError } from '../src/ai/approval/approval-error.js';
import { InMemoryStore } from '../src/ai/memory/index.js';

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. ApprovalPolicy — defaults');
  const policy = new ApprovalPolicy();
  check(
    'read-only agent (discovery-agent) is NEVER',
    policy.decideForAgent('discovery-agent') === 'NEVER',
  );
  check('risk-agent is NEVER', policy.decideForAgent('risk-agent') === 'NEVER');
  check('compliance-agent is NEVER', policy.decideForAgent('compliance-agent') === 'NEVER');
  check('report-agent is NEVER', policy.decideForAgent('report-agent') === 'NEVER');
  check('copilot-agent is NEVER', policy.decideForAgent('copilot-agent') === 'NEVER');
  check(
    'low-risk recommendation-agent is AUTO',
    policy.decideForAgent('recommendation-agent') === 'AUTO',
  );
  check(
    'unregistered agentId defaults to NEVER',
    policy.decideForAgent('never-seen-agent') === 'NEVER',
  );

  console.log('2. ApprovalPolicy — register() (future write-capable agent/tool)');
  policy.register('delete-resource-agent', 'MANUAL');
  check(
    '"delete resource" style agent registers as MANUAL',
    policy.decideForAgent('delete-resource-agent') === 'MANUAL',
  );
  check(
    'decideForToolPermissions: a write-permission tool is MANUAL',
    policy.decideForToolPermissions(['read', 'write']) === 'MANUAL',
  );
  check(
    'decideForToolPermissions: a read-only tool is NEVER',
    policy.decideForToolPermissions(['read', 'database']) === 'NEVER',
  );

  console.log('3. ApprovalEngine.requestApproval — AUTO self-approves immediately');
  const store = new ApprovalStore(new InMemoryStore());
  const engine = new ApprovalEngine(store);

  const autoRequest = await engine.requestApproval({
    executionId: 'exec-1',
    planId: 'plan-1',
    workflowId: 'wf-1',
    stepId: 'step-1',
    agentId: 'recommendation-agent',
    decision: 'AUTO',
    reason: 'test',
  });
  check('AUTO request is immediately APPROVED', autoRequest.status === 'APPROVED');
  check('AUTO request records decidedBy: system', autoRequest.decidedBy === 'system');

  console.log('4. ApprovalEngine.requestApproval — MANUAL stays PENDING');
  const manualRequest = await engine.requestApproval({
    executionId: 'exec-1',
    planId: 'plan-1',
    workflowId: 'wf-1',
    stepId: 'step-2',
    agentId: 'delete-resource-agent',
    decision: 'MANUAL',
    reason: 'test',
  });
  check('MANUAL request stays PENDING', manualRequest.status === 'PENDING');

  console.log('5. ApprovalEngine.decide — approve/reject/comment/edit (spec #5)');
  const approved = await engine.decide(manualRequest.id, 'APPROVED', {
    reviewerId: 'reviewer-1',
    reason: 'looks safe',
    comment: 'go ahead',
    editedOutput: { recommendation: 'edited by reviewer' },
  });
  check('decide(APPROVED) updates status', approved.status === 'APPROVED');
  check('decide(APPROVED) records reviewerId', approved.decidedBy === 'reviewer-1');
  check('decide(APPROVED) records reason', approved.decisionReason === 'looks safe');
  check('decide(APPROVED) records comment', approved.comment === 'go ahead');
  check(
    'decide(APPROVED) records editedOutput ("edit recommendation")',
    JSON.stringify(approved.editedOutput) ===
      JSON.stringify({ recommendation: 'edited by reviewer' }),
  );

  console.log('6. ApprovalEngine.decide — cannot decide twice');
  let threwTwice = false;
  try {
    await engine.decide(manualRequest.id, 'REJECTED', { reviewerId: 'reviewer-2' });
  } catch (err) {
    threwTwice = err instanceof ApprovalError;
  }
  check('deciding an already-decided request throws ApprovalError', threwTwice);

  console.log('7. ApprovalEngine.decide — unknown id throws');
  let threwUnknown = false;
  try {
    await engine.decide('does-not-exist', 'APPROVED', { reviewerId: 'reviewer-1' });
  } catch (err) {
    threwUnknown = err instanceof ApprovalError;
  }
  check('deciding an unknown id throws ApprovalError', threwUnknown);

  console.log('8. ApprovalStore.listPending()');
  const pendingRequest = await engine.requestApproval({
    executionId: 'exec-2',
    planId: 'plan-2',
    workflowId: 'wf-2',
    stepId: 'step-3',
    agentId: 'delete-resource-agent',
    decision: 'MANUAL',
    reason: 'test 2',
  });
  const pending = await engine.listPending();
  check(
    'listPending includes the still-pending request',
    pending.some((r) => r.id === pendingRequest.id),
  );
  check(
    'listPending excludes the already-decided request',
    !pending.some((r) => r.id === manualRequest.id),
  );
  check(
    'listPending excludes the already-approved AUTO request',
    !pending.some((r) => r.id === autoRequest.id),
  );

  console.log(
    '9. Backward compatibility — get() returns undefined for an unknown id, not an error',
  );
  check('get() on unknown id resolves undefined', (await engine.get('nope')) === undefined);

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll approval engine checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
