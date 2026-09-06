// Phase 17 — Orchestrator Agent unit-level checks. Like verify-ai-foundation.ts,
// this runs entirely in-process (no running API server needed) since this
// module ships no business logic of its own to hit over HTTP — it only
// registers new routes that delegate straight to OrchestratorService.
// Follows the shared createChecker() convention (scripts/lib/verify-helpers.ts).
//
// No concrete agent ships in this phase (Discovery/Risk/Compliance/
// Recommendation/Report/Copilot are interfaces only), so these checks
// register throwaway fake agents to prove the engine — dependency waves,
// retries, timeouts, cancellation, conditional/skip steps — actually
// works end to end, without implementing any real agent logic.
import { createChecker } from './lib/verify-helpers.js';
import {
  OrchestratorError,
  WorkflowError,
  PlanningError,
  AgentNotRegisteredError,
  WorkflowTimeoutError,
  WorkflowCancelledError,
} from '../src/ai/orchestrator/errors/index.js';
import { OrchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import {
  WorkflowEngine,
  buildWorkflowVisualization,
} from '../src/ai/orchestrator/workflow.engine.js';
import { WorkflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import { Planner } from '../src/ai/orchestrator/planner.js';
import { Executor } from '../src/ai/orchestrator/executor.js';
import { StateManager } from '../src/ai/orchestrator/state.manager.js';
import { ExecutionHistory } from '../src/ai/orchestrator/execution.history.js';
import { OrchestratorService } from '../src/ai/orchestrator/orchestrator.service.js';
import { buildOrchestrationContext } from '../src/ai/orchestrator/execution.context.js';
import { InMemoryStore } from '../src/ai/memory/index.js';
import { redis } from '../src/cache/redis.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { workflowRegistry as globalWorkflowRegistry } from '../src/ai/orchestrator/workflow.registry.js';
import type { OrchestratorAgent } from '../src/ai/orchestrator/agents/agent.interface.js';

function fakeAgent(
  id: string,
  impl: (input: Record<string, unknown>) => Promise<unknown>,
): OrchestratorAgent {
  return {
    id,
    description: `fake agent ${id}`,
    canHandle: () => true,
    execute: (input, _context) => impl(input),
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. Error hierarchy');
  check('OrchestratorError instanceof Error', new OrchestratorError('x') instanceof Error);
  check(
    'WorkflowError extends OrchestratorError',
    new WorkflowError('x') instanceof OrchestratorError,
  );
  check(
    'PlanningError extends OrchestratorError',
    new PlanningError('x') instanceof OrchestratorError,
  );
  const notRegistered = new AgentNotRegisteredError('missing-agent');
  check(
    'AgentNotRegisteredError carries agentId',
    notRegistered.agentId === 'missing-agent' && notRegistered instanceof OrchestratorError,
  );
  check(
    'WorkflowTimeoutError carries stepId/timeoutMs',
    new WorkflowTimeoutError('step-1', 500).timeoutMs === 500,
  );
  check(
    'WorkflowCancelledError extends OrchestratorError',
    new WorkflowCancelledError() instanceof OrchestratorError,
  );

  console.log('2. Agent registry — register/unregister/get/list/isRegistered');
  const registry = new OrchestratorAgentRegistry();
  check('registry starts empty', registry.list().length === 0);
  const echoAgent = fakeAgent('echo-agent', (input) => Promise.resolve({ echoed: input }));
  registry.register(echoAgent);
  check('registry.isRegistered() true after register', registry.isRegistered('echo-agent'));
  check('registry.get() resolves the registered agent', registry.get('echo-agent') === echoAgent);
  check('registry.list() reports one agent', registry.list().length === 1);
  let notFoundThrew = false;
  try {
    registry.get('does-not-exist');
  } catch (e) {
    notFoundThrew = e instanceof AgentNotRegisteredError;
  }
  check('registry.get() throws AgentNotRegisteredError for unknown id', notFoundThrew);
  registry.unregister('echo-agent');
  check('registry.unregister() removes the agent', !registry.isRegistered('echo-agent'));

  console.log('3. Real orchestratorAgentRegistry singleton is empty (no concrete agents shipped)');
  check(
    'orchestratorAgentRegistry is empty in Phase 17',
    orchestratorAgentRegistry.list().length === 0,
  );

  console.log('4. Workflow registry — configurable workflow templates');
  check(
    'default templates seeded (full-security-analysis, risk-only, compliance-only)',
    globalWorkflowRegistry.has('full-security-analysis') &&
      globalWorkflowRegistry.has('risk-only') &&
      globalWorkflowRegistry.has('compliance-only'),
  );
  const fullDef = globalWorkflowRegistry.get('full-security-analysis');
  check('full-security-analysis has 5 steps', fullDef.steps.length === 5);
  const viz = buildWorkflowVisualization(fullDef);
  check(
    'buildWorkflowVisualization produces nodes/edges',
    viz.nodes.length === 5 && viz.edges.length === 5,
  );
  let unknownWorkflowThrew = false;
  try {
    globalWorkflowRegistry.get('does-not-exist');
  } catch (e) {
    unknownWorkflowThrew = e instanceof WorkflowError;
  }
  check('workflowRegistry.get() throws WorkflowError for unknown id', unknownWorkflowThrew);

  console.log('5. Planner — intent -> execution plan (no business logic executed)');
  const planner = new Planner();
  const plan = planner.createPlan({ intent: 'Analyze my GitHub organization' });
  check(
    'planner maps GitHub intent to full-security-analysis',
    plan.workflowId === 'full-security-analysis',
  );
  check(
    'plan steps are Discovery -> Risk -> Compliance -> Recommendation -> Report',
    plan.steps.map((s) => s.agentId).join(',') ===
      'discovery-agent,risk-agent,compliance-agent,recommendation-agent,report-agent',
  );
  const riskPlan = planner.createPlan({ intent: 'just check risk please' });
  check('planner maps risk intent to risk-only', riskPlan.workflowId === 'risk-only');
  const directPlan = planner.createPlan({ intent: 'compliance-only' });
  check(
    'planner accepts a workflow id directly as intent',
    directPlan.workflowId === 'compliance-only',
  );
  let planningFailed = false;
  try {
    planner.createPlan({ intent: 'xyzzy nonsense intent' });
  } catch (e) {
    planningFailed = e instanceof PlanningError;
  }
  check('planner throws PlanningError for unrecognized intent', planningFailed);

  console.log('6. Workflow engine — dependency waves, parallel + sequential execution');
  const engine = new WorkflowEngine();
  const order: string[] = [];
  orchestratorAgentRegistry.register(
    fakeAgent('a', () => {
      order.push('a');
      return Promise.resolve({ ok: true });
    }),
  );
  orchestratorAgentRegistry.register(
    fakeAgent('b', () => {
      order.push('b');
      return Promise.resolve({ ok: true });
    }),
  );
  orchestratorAgentRegistry.register(
    fakeAgent('c', () => {
      order.push('c');
      return Promise.resolve({ ok: true });
    }),
  );

  const waveDefinition = {
    id: 'test-waves',
    name: 'Test Waves',
    description: 'a,b in parallel -> c depends on both',
    steps: [
      { stepId: 's-a', agentId: 'a' },
      { stepId: 's-b', agentId: 'b' },
      { stepId: 's-c', agentId: 'c', dependsOn: ['s-a', 's-b'] },
    ],
  };
  const testContext = buildOrchestrationContext({
    executionId: 'exec-test-waves',
    user: { id: 'u1', role: 'ADMIN' },
  });
  const waveRunResult = await engine.run(waveDefinition, testContext);
  check('workflow engine completes all steps successfully', waveRunResult.status === 'COMPLETED');
  check(
    'dependent step runs after its dependencies',
    order.indexOf('c') > order.indexOf('a') && order.indexOf('c') > order.indexOf('b'),
  );
  check(
    'OrchestrationContext.agentOutputs is not mutated by the engine itself (Executor does that)',
    testContext.agentOutputs.length === 0,
  );

  console.log('7. Workflow engine — conditional (skip) steps');
  const skipDefinition = {
    id: 'test-skip',
    name: 'Test Skip',
    description: 'conditionally skips a',
    steps: [{ stepId: 's-a', agentId: 'a', condition: () => false }],
  };
  const skipResult = await engine.run(
    skipDefinition,
    buildOrchestrationContext({ executionId: 'exec-skip', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check('condition=false skips the step', skipResult.steps[0].status === 'SKIPPED');

  console.log('8. Workflow engine — retries and eventual failure');
  let attemptCount = 0;
  orchestratorAgentRegistry.register(
    fakeAgent('flaky', () => {
      attemptCount += 1;
      if (attemptCount < 3) return Promise.reject(new Error('transient failure'));
      return Promise.resolve({ recovered: true });
    }),
  );
  const retryDefinition = {
    id: 'test-retry',
    name: 'Test Retry',
    description: 'retries a flaky agent',
    steps: [{ stepId: 's-flaky', agentId: 'flaky', maxAttempts: 5 }],
  };
  const retryResult = await engine.run(
    retryDefinition,
    buildOrchestrationContext({ executionId: 'exec-retry', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'step succeeds after retries',
    retryResult.steps[0].status === 'SUCCESS' && retryResult.steps[0].attempts === 3,
  );

  orchestratorAgentRegistry.register(
    fakeAgent('always-fails', () => Promise.reject(new Error('nope'))),
  );
  const failDefinition = {
    id: 'test-fail',
    name: 'Test Fail',
    description: 'always fails, exhausts retries',
    steps: [{ stepId: 's-fail', agentId: 'always-fails', maxAttempts: 2 }],
  };
  const failResult = await engine.run(
    failDefinition,
    buildOrchestrationContext({ executionId: 'exec-fail', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'step fails after exhausting retries, workflow reports FAILED',
    failResult.steps[0].status === 'FAILED' &&
      failResult.steps[0].attempts === 2 &&
      failResult.status === 'FAILED',
  );

  console.log('9. Workflow engine — timeout handling');
  orchestratorAgentRegistry.register(
    fakeAgent(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 200)),
    ),
  );
  const timeoutDefinition = {
    id: 'test-timeout',
    name: 'Test Timeout',
    description: 'agent exceeds its step timeout',
    steps: [{ stepId: 's-slow', agentId: 'slow', timeoutMs: 20, maxAttempts: 1 }],
  };
  const timeoutResult = await engine.run(
    timeoutDefinition,
    buildOrchestrationContext({ executionId: 'exec-timeout', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'step exceeding timeoutMs is reported TIMED_OUT',
    timeoutResult.steps[0].status === 'TIMED_OUT',
  );

  console.log('10. Workflow engine — cancellation');
  const cancelController = new AbortController();
  orchestratorAgentRegistry.register(
    fakeAgent(
      'cancel-me',
      () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 100)),
    ),
  );
  const cancelDefinition = {
    id: 'test-cancel',
    name: 'Test Cancel',
    description: 'wave 2 should never run once cancelled',
    steps: [
      { stepId: 's-1', agentId: 'a' },
      { stepId: 's-2', agentId: 'cancel-me', dependsOn: ['s-1'] },
    ],
  };
  cancelController.abort();
  const cancelResult = await engine.run(
    cancelDefinition,
    buildOrchestrationContext({ executionId: 'exec-cancel', user: { id: 'u1', role: 'ADMIN' } }),
    { signal: cancelController.signal },
  );
  check(
    'pre-aborted signal short-circuits the run as CANCELLED',
    cancelResult.status === 'CANCELLED',
  );

  console.log('11. Workflow engine — unregistered agent fails the step, not the whole run');
  const missingAgentDefinition = {
    id: 'test-missing-agent',
    name: 'Test Missing Agent',
    description: 'references an agent that was never registered',
    steps: [{ stepId: 's-missing', agentId: 'never-registered' }],
  };
  const missingResult = await engine.run(
    missingAgentDefinition,
    buildOrchestrationContext({ executionId: 'exec-missing', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'unregistered agent produces a FAILED step with a clear error, without throwing',
    missingResult.steps[0].status === 'FAILED' && !!missingResult.steps[0].error,
  );

  console.log('12. StateManager — Redis-backed execution state tracking');
  const memoryStore = new InMemoryStore();
  const stateManager = new StateManager(memoryStore);
  const stateContext = buildOrchestrationContext({
    executionId: 'exec-state-1',
    user: { id: 'u1', role: 'ADMIN' },
  });
  await stateManager.create({
    executionId: 'exec-state-1',
    workflowId: 'test-waves',
    startedAt: new Date().toISOString(),
    context: stateContext,
  });
  const created = await stateManager.get('exec-state-1');
  check('StateManager.create() persists initial RUNNING state', created?.status === 'RUNNING');
  await stateManager.touchCurrentStep('exec-state-1', 's-a');
  const touched = await stateManager.get('exec-state-1');
  check('StateManager.touchCurrentStep() updates currentStep', touched?.currentStep === 's-a');
  const finalized = await stateManager.finalize(
    'exec-state-1',
    waveRunResult.steps,
    'COMPLETED',
    new Date().toISOString(),
  );
  check(
    'StateManager.finalize() computes completedSteps from step results',
    finalized.completedSteps.length === 3 && finalized.status === 'COMPLETED',
  );

  console.log('13. ExecutionHistory — append-only run log');
  const history = new ExecutionHistory(memoryStore);
  await history.record({
    executionId: 'exec-hist-1',
    workflowId: 'test-waves',
    status: 'COMPLETED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 42,
    steps: [],
    data: {},
  });
  const historyList = await history.list(10);
  check(
    'ExecutionHistory.record()/.list() roundtrip',
    historyList[0]?.executionId === 'exec-hist-1',
  );

  console.log('14. Executor + OrchestratorService — full end-to-end run against fake agents');
  const e2eRegistry = orchestratorAgentRegistry; // reuse the real singleton (a/b/c already registered above)
  check('sanity: shared registry has fake agents from step 6', e2eRegistry.isRegistered('a'));

  const e2eWorkflowRegistry = new WorkflowRegistry();
  const e2eDefinition = {
    id: 'e2e-workflow',
    name: 'E2E Workflow',
    description: 'a,b parallel -> c',
    steps: [
      { stepId: 's-a', agentId: 'a' },
      { stepId: 's-b', agentId: 'b' },
      { stepId: 's-c', agentId: 'c', dependsOn: ['s-a', 's-b'] },
    ],
  };
  e2eWorkflowRegistry.register(e2eDefinition);
  // Executor/OrchestratorService resolve workflows through the module-level
  // `workflowRegistry` singleton (imported directly in those files), not an
  // injectable one — register the same definition there too so this
  // end-to-end run resolves it.
  globalWorkflowRegistry.register(e2eDefinition);

  const e2eMemoryStore = new InMemoryStore();
  const e2eStateManager = new StateManager(e2eMemoryStore);
  const e2eHistory = new ExecutionHistory(e2eMemoryStore);
  const e2eExecutor = new Executor(e2eStateManager, e2eHistory);
  const e2ePlanner = new Planner();
  const service = new OrchestratorService(e2ePlanner, e2eExecutor, e2eStateManager, e2eHistory);

  const result = await service.execute({
    intent: 'e2e-workflow',
    user: { id: 'u1', role: 'ADMIN' },
  });
  check('OrchestratorService.execute() completes the workflow', result.status === 'COMPLETED');
  check(
    'ExecutionResult.data aggregates each agent output by agentId',
    'a' in result.data && 'b' in result.data && 'c' in result.data,
  );

  const status = await service.getStatus(result.executionId);
  check(
    'OrchestratorService.getStatus() reflects the finished run',
    status?.status === 'COMPLETED',
  );

  const serviceHistory = await service.getHistory(5);
  check(
    'OrchestratorService.getHistory() includes the run just executed',
    serviceHistory.some((h) => h.executionId === result.executionId),
  );

  check(
    'OrchestratorService.listWorkflows() includes the e2e workflow',
    service.listWorkflows().some((w) => w.id === 'e2e-workflow'),
  );
  check(
    'OrchestratorService.getWorkflow() resolves it directly',
    service.getWorkflow('e2e-workflow').id === 'e2e-workflow',
  );

  let cancelOfUnknownThrew = false;
  try {
    service.cancel('not-a-real-execution-id');
  } catch (e) {
    cancelOfUnknownThrew = e instanceof WorkflowError;
  }
  check(
    'OrchestratorService.cancel() throws for an unknown/finished execution',
    cancelOfUnknownThrew,
  );

  // Cleanup shared singleton state so this script can be re-run idempotently.
  ['a', 'b', 'c', 'flaky', 'always-fails', 'slow', 'cancel-me'].forEach((id) =>
    orchestratorAgentRegistry.unregister(id),
  );
  globalWorkflowRegistry.unregister('e2e-workflow');

  if (state.failed) {
    console.error('\nOne or more Orchestrator checks FAILED.');
  } else {
    console.log('\nAll Orchestrator checks passed.');
  }

  // orchestrator/telemetry.ts pulls in observability/metrics.ts, which
  // registers a collect() hook reading workerPool stats — that module
  // transitively imports cache/redis.ts, opening a real connection as a
  // side effect of import alone. Close it so this script can exit cleanly,
  // same as verify-ai-foundation.ts does.
  await redis.quit().catch(() => undefined);

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
