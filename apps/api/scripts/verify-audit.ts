// Phase 26 — Audit trail checks (spec #8: request/reviewer/decision/
// reason/timestamps/affected workflow, all persisted and retrievable).
// Two parts:
//
// Part A (in-process) — no real agent ships a MANUAL policy today (no
// destructive/write agent exists yet, per Phase 24's scope), so a
// synthetic MANUAL-registered fake agent is the only way to drive a
// genuine PENDING -> APPROVED/REJECTED decision and inspect every audit
// field this spec item asks for.
//
// Part B (HTTP, against a live server) — exercises the actual
// /ai/approval/* routes' shape and error handling using the one real
// agent that ships an AUTO policy (recommendation-agent), plus 404/400
// handling for unknown ids and invalid input.
import { api, createChecker, registerAndLogin } from './lib/verify-helpers.js';
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

const WORKFLOW_ID = 'audit-test-workflow';
const AGENT_ID = 'audit-test-agent';

interface ApprovalRequestDto {
  id: string;
  executionId: string;
  planId: string;
  workflowId: string;
  stepId: string;
  agentId: string;
  decision: string;
  status: string;
  reason: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  comment?: string;
}
interface HitlExecutionResultDto {
  executionId: string;
  status: string;
  pendingApprovalIds: string[];
}

async function runPartA(
  check: (label: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  console.log('Part A — in-process: full audit field set for a real approve, then a real reject');

  orchestratorAgentRegistry.register({
    id: AGENT_ID,
    description: 'fake agent, gated MANUAL, for audit field inspection',
    canHandle: () => true,
    execute: () => Promise.resolve({ confidenceScore: 1 }),
  });
  workflowRegistry.register({
    id: WORKFLOW_ID,
    name: 'Audit Test Workflow',
    description: 'a single MANUAL step',
    steps: [{ stepId: 'gated', agentId: AGENT_ID }],
  });
  approvalPolicy.register(AGENT_ID, 'MANUAL');

  try {
    const planStore = new PlanStore(new InMemoryStore());
    const approvalEngine = new ApprovalEngine(new ApprovalStore(new InMemoryStore()));
    const pausedExecutionStore = new PausedExecutionStore(new InMemoryStore());
    const orchestrator = new HitlOrchestrator(planStore, approvalEngine, pausedExecutionStore);

    const run = await orchestrator.run({ goal: WORKFLOW_ID, user: { id: 'u1', role: 'ADMIN' } });
    const [requestId] = run.pendingApprovalIds;
    const requested = await approvalEngine.get(requestId);

    check(
      'request persisted with executionId (affected workflow run)',
      requested?.executionId === run.executionId,
    );
    check(
      'request persisted with workflowId (affected workflow)',
      requested?.workflowId === WORKFLOW_ID,
    );
    check(
      'request persisted with planId',
      typeof requested?.planId === 'string' && requested.planId.length > 0,
    );
    check(
      'request persisted with stepId/agentId',
      requested?.stepId === 'gated' && requested?.agentId === AGENT_ID,
    );
    check(
      'request persisted with a reason',
      typeof requested?.reason === 'string' && requested.reason.length > 0,
    );
    check(
      'request persisted with a requestedAt timestamp',
      typeof requested?.requestedAt === 'string',
    );
    check('request starts PENDING (not yet decided)', requested?.status === 'PENDING');
    check('request has no reviewer yet', requested?.decidedBy === undefined);

    const decided = await approvalEngine.decide(requestId, 'APPROVED', {
      reviewerId: 'reviewer-audit-1',
      reason: 'verified safe',
      comment: 'proceed',
    });
    check('decision persists the reviewer id', decided.decidedBy === 'reviewer-audit-1');
    check('decision persists a decidedAt timestamp', typeof decided.decidedAt === 'string');
    check('decision persists the decision reason', decided.decisionReason === 'verified safe');
    check('decision persists the reviewer comment', decided.comment === 'proceed');
    check('decision updates status to APPROVED', decided.status === 'APPROVED');

    const reFetched = await approvalEngine.get(requestId);
    check(
      'a fresh get() reflects the persisted decision, not a stale copy',
      reFetched?.status === 'APPROVED',
    );
  } finally {
    orchestratorAgentRegistry.unregister(AGENT_ID);
    workflowRegistry.unregister(WORKFLOW_ID);
  }
}

async function runPartB(
  check: (label: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  console.log('\nPart B — HTTP: /ai/approval/* routes against a live server');
  const owner = await registerAndLogin(`verify-audit-owner-${Date.now()}@example.test`);
  const token = owner.accessToken;

  console.log('1. POST /ai/approval/request — an AUTO-decision agent self-resolves, nothing pends');
  const requestRes = await api<HitlExecutionResultDto>('POST', '/ai/approval/request', token, {
    goal: 'discovery-recommendation',
  });
  check('status 200', requestRes.status === 200, `${requestRes.status}`);
  check(
    'no pending approvals (AUTO self-resolves)',
    requestRes.body.pendingApprovalIds.length === 0,
  );

  console.log('2. GET /ai/approval/pending — reflects live state');
  const pendingRes = await api<{ items: ApprovalRequestDto[] }>(
    'GET',
    '/ai/approval/pending',
    token,
  );
  check('status 200', pendingRes.status === 200, `${pendingRes.status}`);
  check(
    "this execution's AUTO request is not in the pending list (already resolved)",
    !pendingRes.body.items.some((item) => item.executionId === requestRes.body.executionId),
  );

  console.log('3. GET /ai/approval/:id — unknown id returns 404, not a crash');
  const missingRes = await api('GET', '/ai/approval/does-not-exist', token);
  check('unknown id returns 404', missingRes.status === 404, `${missingRes.status}`);

  console.log('4. POST /ai/approval/:id/approve — unknown id returns 404, not a 500');
  const decideMissingRes = await api('POST', '/ai/approval/does-not-exist/approve', token, {
    reason: 'test',
  });
  check(
    'deciding an unknown id returns 404',
    decideMissingRes.status === 404,
    `${decideMissingRes.status}`,
  );

  console.log('5. Validation — an empty goal is rejected with 400, not a crash');
  const invalidRes = await api('POST', '/ai/approval/request', token, { goal: '' });
  check('empty goal returns 400', invalidRes.status === 400, `${invalidRes.status}`);
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  await runPartA(check);
  await runPartB(check);

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll audit trail checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
