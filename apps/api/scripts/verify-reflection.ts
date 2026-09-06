// Phase 25 — ReflectionEngine + ReflectionStore/PlanStore unit checks.
// Runs in-process against InMemoryStore (no Redis needed) and hand-built
// ExecutionResult/ReasoningPlan/CriticReport fixtures.
import { createChecker } from './lib/verify-helpers.js';
import { InMemoryStore } from '../src/ai/memory/index.js';
import { GoalPlanner } from '../src/ai/planner/goal-planner.js';
import { PlanStore } from '../src/ai/planner/plan-store.js';
import { Critic } from '../src/ai/critic/critic.js';
import { ReflectionEngine } from '../src/ai/reflection/reflection.engine.js';
import { ReflectionStore } from '../src/ai/reflection/reflection.store.js';
import {
  buildOrchestrationContext,
  recordAgentOutput,
} from '../src/ai/orchestrator/execution.context.js';
import type { ExecutionResult } from '../src/ai/orchestrator/execution.result.js';
import { redis } from '../src/cache/redis.js';

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const goalPlanner = new GoalPlanner();
  const critic = new Critic();
  const reflectionEngine = new ReflectionEngine();
  const store = new InMemoryStore();
  const planStore = new PlanStore(store);
  const reflectionStore = new ReflectionStore(store);

  console.log('1. reflect — a fully successful run');
  const plan = goalPlanner.createPlan('assess risk for this account'); // risk-only: discovery -> risk
  const context = buildOrchestrationContext({
    executionId: 'exec-refl-1',
    user: { id: 'u1', role: 'ADMIN' },
    workflowId: plan.workflowId,
  });
  recordAgentOutput(context, {
    stepId: 'discovery',
    agentId: 'discovery-agent',
    status: 'SUCCESS',
    output: { assets: [{ id: 'a1' }] },
    confidence: 0.9,
  });
  recordAgentOutput(context, {
    stepId: 'risk',
    agentId: 'risk-agent',
    status: 'SUCCESS',
    output: { findings: [{ id: 'f1' }] },
    confidence: 0.85,
  });

  const successResult: ExecutionResult = {
    executionId: context.executionId,
    workflowId: plan.workflowId,
    status: 'COMPLETED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 500,
    data: {},
    steps: [
      {
        stepId: 'discovery',
        agentId: 'discovery-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        output: { assets: [{ id: 'a1' }] },
      },
      {
        stepId: 'risk',
        agentId: 'risk-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        output: { findings: [{ id: 'f1' }] },
      },
    ],
  };
  const criticReport = critic.evaluateExecution(successResult, plan);
  const reflection = reflectionEngine.reflect(successResult, plan, plan, criticReport, context);
  check('succeededSteps lists both steps', reflection.succeededSteps.length === 2);
  check('failedSteps is empty', reflection.failedSteps.length === 0);
  check('overallConfidence is high for a clean run', reflection.overallConfidence > 0.7);
  check('notes mention the resolved workflow', reflection.notes[0].includes(plan.workflowId));
  check(
    'no revision note when plan === finalPlan',
    !reflection.notes.some((n) => n.startsWith('plan revised')),
  );

  console.log('2. reflect — a partial run with a revised plan');
  const failedResult: ExecutionResult = {
    ...successResult,
    status: 'PARTIAL',
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
    ],
  };
  const finalPlan = goalPlanner.revisePlan(plan, failedResult);
  const partialCritic = critic.evaluateExecution(failedResult, plan);
  const partialReflection = reflectionEngine.reflect(
    failedResult,
    plan,
    finalPlan,
    partialCritic,
    context,
  );
  check('failedSteps lists discovery', partialReflection.failedSteps.includes('discovery'));
  check('skippedSteps lists risk', partialReflection.skippedSteps.includes('risk'));
  check(
    'finalPlanId differs from planId',
    partialReflection.finalPlanId !== partialReflection.planId,
  );
  check(
    'notes explain the plan revision',
    partialReflection.notes.some((n) => n.startsWith('plan revised')),
  );

  console.log('3. weak recommendation / incomplete report detection');
  const weakResult: ExecutionResult = {
    ...successResult,
    steps: [
      {
        stepId: 'rec',
        agentId: 'recommendation-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        output: { recommendations: [] },
      },
      {
        stepId: 'rep',
        agentId: 'report-agent',
        status: 'SUCCESS',
        startedAt: '',
        finishedAt: '',
        durationMs: 0,
        attempts: 1,
        output: { sections: [] },
      },
    ],
  };
  const weakCritic = critic.evaluateExecution(weakResult, plan);
  const weakReflection = reflectionEngine.reflect(weakResult, plan, plan, weakCritic, context);
  check(
    'weakRecommendations flags the empty recommendation-agent output',
    weakReflection.weakRecommendations.includes('rec'),
  );
  check(
    'incompleteReports flags the empty report-agent output',
    weakReflection.incompleteReports.includes('rep'),
  );

  console.log('4. PlanStore + ReflectionStore round-trip (InMemoryStore)');
  await planStore.save(plan);
  await planStore.save(finalPlan);
  await reflectionStore.save(partialReflection);
  const fetchedPlan = await planStore.get(plan.planId);
  const fetchedFinalPlan = await planStore.get(finalPlan.planId);
  const fetchedReflection = await reflectionStore.get(partialReflection.executionId);
  check('PlanStore round-trips the initial plan', fetchedPlan?.planId === plan.planId);
  check('PlanStore round-trips the revised plan', fetchedFinalPlan?.planId === finalPlan.planId);
  check(
    'ReflectionStore round-trips by executionId',
    fetchedReflection?.executionId === partialReflection.executionId,
  );
  check(
    'missing plan id returns undefined, not an error',
    (await planStore.get('nope')) === undefined,
  );

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll reflection checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
