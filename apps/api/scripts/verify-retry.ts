// Phase 25 — Retry Policy checks. Runs entirely in-process: no server
// needed, since this only exercises classifyError()/isRetryableError()
// (ai/utils/retry-policy.ts) and WorkflowEngine's use of it directly.
import { createChecker } from './lib/verify-helpers.js';
import { classifyError, isRetryableError } from '../src/ai/utils/retry-policy.js';
import { WorkflowEngine } from '../src/ai/orchestrator/workflow.engine.js';
import { OrchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { orchestratorAgentRegistry as globalAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { buildOrchestrationContext } from '../src/ai/orchestrator/execution.context.js';
import type { OrchestratorAgent } from '../src/ai/orchestrator/agents/agent.interface.js';
import { redis } from '../src/cache/redis.js';

function fakeAgent(
  id: string,
  impl: (input: Record<string, unknown>) => Promise<unknown>,
): OrchestratorAgent {
  return {
    id,
    description: `fake agent ${id}`,
    canHandle: () => true,
    execute: (input) => impl(input),
  };
}

class PermissionDeniedError extends Error {
  constructor() {
    super('permission denied');
    this.name = 'ForbiddenError';
  }
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. classifyError — recoverable defaults');
  check(
    'generic Error is RECOVERABLE',
    classifyError(new Error('transient failure')) === 'RECOVERABLE',
  );
  check('timeout-flavored Error is RECOVERABLE', isRetryableError(new Error('ETIMEDOUT')));

  console.log('2. classifyError — permanent by name/message');
  check(
    'ForbiddenError-named Error is PERMANENT',
    classifyError(new PermissionDeniedError()) === 'PERMANENT',
  );
  check(
    'validation-message Error is PERMANENT',
    classifyError(new Error('validation failed: missing field')) === 'PERMANENT',
  );
  check('non-Error value is RECOVERABLE (safe default)', isRetryableError('not an Error object'));

  console.log('3. WorkflowEngine only retries recoverable failures');
  // Uses this test's own OrchestratorAgentRegistry-registered fake agents
  // registered into the *global* registry (the one WorkflowEngine
  // resolves against) — matches the pattern verify-orchestrator.ts uses.
  const engine = new WorkflowEngine();
  let recoverableAttempts = 0;
  globalAgentRegistry.register(
    fakeAgent('retry-recoverable', () => {
      recoverableAttempts += 1;
      return Promise.reject(new Error('transient db timeout'));
    }),
  );
  const recoverableResult = await engine.run(
    {
      id: 'test-retry-recoverable',
      name: 'Test',
      description: 'retries a recoverable failure until exhausted',
      steps: [{ stepId: 's1', agentId: 'retry-recoverable', maxAttempts: 3 }],
    },
    buildOrchestrationContext({ executionId: 'exec-r1', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'recoverable failure is retried up to maxAttempts',
    recoverableResult.steps[0].attempts === 3 && recoverableResult.steps[0].status === 'FAILED',
  );
  check('the agent itself was actually invoked 3 times', recoverableAttempts === 3);

  let permanentAttempts = 0;
  globalAgentRegistry.register(
    fakeAgent('retry-permanent', () => {
      permanentAttempts += 1;
      return Promise.reject(new PermissionDeniedError());
    }),
  );
  const permanentResult = await engine.run(
    {
      id: 'test-retry-permanent',
      name: 'Test',
      description: 'never retries a permanent failure',
      steps: [{ stepId: 's1', agentId: 'retry-permanent', maxAttempts: 5 }],
    },
    buildOrchestrationContext({ executionId: 'exec-r2', user: { id: 'u1', role: 'ADMIN' } }),
  );
  check(
    'permanent failure is attempted exactly once, never retried',
    permanentAttempts === 1 && permanentResult.steps[0].attempts === 1,
  );

  console.log('4. Backward compatibility — unused registry import compiles');
  check(
    'OrchestratorAgentRegistry constructible',
    new OrchestratorAgentRegistry() instanceof OrchestratorAgentRegistry,
  );

  if (state.failed) {
    console.error('\nSome checks FAILED');
    process.exit(1);
  }
  console.log('\nAll retry-policy checks passed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => redis.quit().catch(() => undefined));
