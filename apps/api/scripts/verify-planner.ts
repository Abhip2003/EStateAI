// Phase 25 — GoalPlanner unit checks. Runs in-process against the real
// workflowRegistry (read-only, already seeded by ai/orchestrator/workflow.registry.ts)
// — no server or database needed.
import { createChecker } from './lib/verify-helpers.js';
import { GoalPlanner } from '../src/ai/planner/goal-planner.js';
import type { ExecutionResult } from '../src/ai/orchestrator/execution.result.js';
import { redis } from '../src/cache/redis.js';

function main(): void {
  const { check, state } = createChecker();
  const goalPlanner = new GoalPlanner();

  console.log('1. createPlan — full security analysis goal');
  const plan = goalPlanner.createPlan('Generate a complete security report');
  check(
    'workflow resolved to full-security-analysis',
    plan.workflowId === 'full-security-analysis',
  );
  check(
    'steps mirror discovery -> risk/compliance -> recommendation -> report',
    plan.steps.length === 5 && plan.steps[0].agentId === 'discovery-agent',
  );
  check(
    'requiredAgents is the unique set of step agentIds',
    plan.requiredAgents.length === 5 && new Set(plan.requiredAgents).size === 5,
  );
  check('requiredTools is non-empty (drawn from AGENT_TOOL_ACCESS)', plan.requiredTools.length > 0);
  check('estimatedComplexity is HIGH for a 5-step plan', plan.estimatedComplexity === 'HIGH');
  check('estimatedDurationMs > 0', plan.estimatedDurationMs > 0);
  check('confidence is within [0.5, 0.9]', plan.confidence >= 0.5 && plan.confidence <= 0.9);
  check('no revisionOf on a fresh plan', plan.revisionOf === undefined);

  console.log('2. createPlan — smaller goal (risk only)');
  const riskPlan = goalPlanner.createPlan('assess risk for this account');
  check('workflow resolved to risk-only', riskPlan.workflowId === 'risk-only');
  check(
    'estimatedComplexity is MEDIUM for a 2-step plan',
    riskPlan.estimatedComplexity === 'MEDIUM',
  );

  console.log('3. createPlan — unresolvable intent throws PlanningError');
  let threw = false;
  try {
    goalPlanner.createPlan('xyzzy nonsense goal with no matching keyword');
  } catch (err) {
    threw = err instanceof Error && err.name === 'PlanningError';
  }
  check('unresolvable goal throws PlanningError', threw);

  console.log('4. revisePlan — Discovery failed -> dependents skipped');
  const fullPlan = goalPlanner.createPlan('Generate a complete security report');
  const failedResult: ExecutionResult = {
    executionId: 'exec-test',
    workflowId: fullPlan.workflowId,
    status: 'PARTIAL',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    data: {},
    steps: [
      {
        stepId: 'discovery',
        agentId: 'discovery-agent',
        status: 'FAILED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        error: 'boom',
      },
      {
        stepId: 'risk',
        agentId: 'risk-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
      {
        stepId: 'compliance',
        agentId: 'compliance-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
      {
        stepId: 'recommendation',
        agentId: 'recommendation-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
      {
        stepId: 'report',
        agentId: 'report-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
    ],
  };
  const revised = goalPlanner.revisePlan(fullPlan, failedResult);
  check('revised plan has a new planId', revised.planId !== fullPlan.planId);
  check('revised plan records revisionOf', revised.revisionOf === fullPlan.planId);
  check(
    'revised plan drops every step (all depend transitively on discovery)',
    revised.steps.length === 0,
  );
  check(
    'revised plan confidence is lower than the original',
    revised.confidence < fullPlan.confidence,
  );

  console.log('5. revisePlan — a step independent of the failure survives');
  const discoveryOnlyFail: ExecutionResult = {
    ...failedResult,
    steps: [
      {
        stepId: 'discovery',
        agentId: 'discovery-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
      },
      {
        stepId: 'risk',
        agentId: 'risk-agent',
        status: 'FAILED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        error: 'boom',
      },
      {
        stepId: 'compliance',
        agentId: 'compliance-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
      },
      {
        stepId: 'recommendation',
        agentId: 'recommendation-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
      {
        stepId: 'report',
        agentId: 'report-agent',
        status: 'SKIPPED',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 0,
      },
    ],
  };
  const partialRevision = goalPlanner.revisePlan(fullPlan, discoveryOnlyFail);
  const survivingStepIds = partialRevision.steps.map((s) => s.stepId);
  check(
    'compliance (independent of the failed risk step) survives revision',
    survivingStepIds.includes('compliance') && !survivingStepIds.includes('risk'),
  );
  check(
    'recommendation (depends on risk) is dropped even though it did not itself fail',
    !survivingStepIds.includes('recommendation'),
  );

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll planner checks passed.');
}

try {
  main();
} catch (err) {
  // process.exit(1) below terminates immediately regardless of the open
  // redis handle (see cache/redis.ts) — quitting it first only matters
  // for the success path, where nothing else forces the process to exit.
  console.error(err);
  process.exit(1);
}
await redis.quit().catch(() => undefined);
