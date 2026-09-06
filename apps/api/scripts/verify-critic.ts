// Phase 25 — Critic unit checks. Pure in-process, constructs
// AgentTaskResult/ExecutionResult/ReasoningPlan fixtures directly rather
// than running a real workflow.
import { createChecker } from './lib/verify-helpers.js';
import { Critic } from '../src/ai/critic/critic.js';
import { aggregateConfidence } from '../src/ai/critic/confidence.js';
import { GoalPlanner } from '../src/ai/planner/goal-planner.js';
import type { AgentTaskResult, ExecutionResult } from '../src/ai/orchestrator/execution.result.js';
import { redis } from '../src/cache/redis.js';

function step(overrides: Partial<AgentTaskResult>): AgentTaskResult {
  return {
    stepId: 's1',
    agentId: 'discovery-agent',
    status: 'SUCCESS',
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    attempts: 1,
    ...overrides,
  };
}

function main(): void {
  const { check, state } = createChecker();
  const critic = new Critic();
  const goalPlanner = new GoalPlanner();

  console.log('1. evaluateStep — FAILED step is CRITICAL');
  const failedFindings = critic.evaluateStep(step({ status: 'FAILED', error: 'db down' }));
  check(
    'FAILED step yields exactly one CRITICAL finding',
    failedFindings.length === 1 && failedFindings[0].severity === 'CRITICAL',
  );

  console.log('2. evaluateStep — SKIPPED step is WARNING');
  const skippedFindings = critic.evaluateStep(step({ status: 'SKIPPED' }));
  check('SKIPPED step yields a WARNING finding', skippedFindings[0]?.severity === 'WARNING');

  console.log('3. evaluateStep — SUCCESS with empty evidence is WARNING');
  const emptyEvidenceFindings = critic.evaluateStep(step({ output: { findings: [] } }));
  check(
    'SUCCESS with an empty array output yields a WARNING finding',
    emptyEvidenceFindings[0]?.severity === 'WARNING',
  );

  console.log('4. evaluateStep — SUCCESS with real evidence is clean');
  const cleanFindings = critic.evaluateStep(step({ output: { findings: [{ id: 'f1' }] } }));
  check('SUCCESS with non-empty evidence yields no findings', cleanFindings.length === 0);

  console.log('5. evaluatePlan — low confidence flagged');
  const plan = goalPlanner.createPlan('Generate a complete security report');
  const lowConfidencePlan = { ...plan, confidence: 0.4 };
  check(
    'low-confidence plan yields a WARNING finding',
    critic.evaluatePlan(lowConfidencePlan).some((f) => f.severity === 'WARNING'),
  );
  check(
    'empty-steps plan yields a CRITICAL finding',
    critic.evaluatePlan({ ...plan, steps: [] }).some((f) => f.severity === 'CRITICAL'),
  );

  console.log('6. evaluateExecution — score reflects success ratio and penalties');
  const allSuccess: ExecutionResult = {
    executionId: 'e1',
    workflowId: plan.workflowId,
    status: 'COMPLETED',
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    data: {},
    steps: [
      step({ output: { findings: [{ id: '1' }] } }),
      step({ stepId: 's2', output: { findings: [{ id: '2' }] } }),
    ],
  };
  const cleanReport = critic.evaluateExecution(allSuccess);
  check('all-success, evidence-bearing execution scores 1.0', cleanReport.score === 1);
  check('no missing evidence reported', cleanReport.missingEvidence.length === 0);

  const partialFailure: ExecutionResult = {
    ...allSuccess,
    status: 'PARTIAL',
    steps: [
      step({ status: 'FAILED', error: 'x' }),
      step({ stepId: 's2', output: { findings: [{ id: '1' }] } }),
    ],
  };
  const partialReport = critic.evaluateExecution(partialFailure);
  check('a failed step drags the score below 1', partialReport.score < 1);
  check(
    'CRITICAL finding recorded for the failed step',
    partialReport.findings.some((f) => f.severity === 'CRITICAL'),
  );

  console.log('7. aggregateConfidence — weighted blend within [0,1]');
  const conf = aggregateConfidence({
    toolSuccessRatio: 1,
    agentConfidences: [0.9, 0.8],
    criticScore: 1,
  });
  check('high inputs yield a high aggregate confidence', conf > 0.8 && conf <= 1);
  const lowConf = aggregateConfidence({
    toolSuccessRatio: 0,
    agentConfidences: [0.2],
    criticScore: 0,
  });
  check('low inputs yield a low aggregate confidence', lowConf < 0.5);
  const missingSignals = aggregateConfidence({
    toolSuccessRatio: 1,
    agentConfidences: [],
    criticScore: 1,
  });
  check(
    'missing signals fall back to a neutral value, not 0 or 1',
    missingSignals > 0 && missingSignals < 1,
  );

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll critic checks passed.');
}

try {
  main();
} catch (err) {
  // process.exit(1) terminates immediately regardless of the open redis
  // handle (see cache/redis.ts) — quitting it only matters on success,
  // where nothing else forces the process to exit.
  console.error(err);
  process.exit(1);
}
await redis.quit().catch(() => undefined);
