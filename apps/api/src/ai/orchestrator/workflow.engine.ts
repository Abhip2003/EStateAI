import type { OrchestrationContext } from './execution.context.js';
import type { AgentTaskResult } from './execution.result.js';
import type { AgentTaskStatus, WorkflowStatus } from './types.js';
import { orchestratorAgentRegistry } from './agent-registry.js';
import { WorkflowError, WorkflowTimeoutError, WorkflowCancelledError } from './errors/index.js';
import { withRetry } from '../utils/retry.js';
import { isRetryableError } from '../utils/retry-policy.js';
import { orchestratorTelemetry } from './telemetry.js';

// One node in a WorkflowDefinition's dependency graph. `condition` enables
// conditional execution (skip a step based on context so far); `dependsOn`
// enables branching/sequential-vs-parallel structure — steps with no
// unresolved dependency execute in parallel within the same "wave" (see
// buildWaves below), steps that depend on others wait for a later wave.
export interface WorkflowStepDefinition {
  stepId: string;
  agentId: string;
  dependsOn?: string[];
  condition?: (context: OrchestrationContext) => boolean;
  timeoutMs?: number;
  maxAttempts?: number;
  input?: Record<string, unknown>;
}

// Visualization-friendly metadata describing a step, independent of the
// executable definition — label/description are optional, purely for
// rendering a workflow diagram (see buildWorkflowVisualization below).
export interface WorkflowStepMetadata {
  label?: string;
  description?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  stepMetadata?: Record<string, WorkflowStepMetadata>;
}

export interface WorkflowRunOptions {
  signal?: AbortSignal;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (result: AgentTaskResult) => void;
}

export interface WorkflowRunResult {
  status: WorkflowStatus;
  steps: AgentTaskResult[];
}

// Partitions steps into dependency "waves" via Kahn's algorithm — every
// step in a wave has all its dependencies already resolved by an earlier
// wave, so a wave's steps run with Promise.all (parallel execution) while
// waves themselves run in sequence (sequential execution across waves).
// This single structure is what gives the engine both sequential and
// parallel execution without two separate code paths. Reimplemented
// independently of services/agents/task.service.ts's equivalent
// buildWaves() since this module must not import from services/agents/.
function buildWaves(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[][] {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const remaining = new Set(steps.map((s) => s.stepId));
  const waves: WorkflowStepDefinition[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining]
      .map((id) => byId.get(id))
      .filter(
        (step): step is WorkflowStepDefinition =>
          step !== undefined && (step.dependsOn ?? []).every((dep) => !remaining.has(dep)),
      );

    if (wave.length === 0) {
      throw new WorkflowError(
        `circular or unresolved dependency among steps: ${[...remaining].join(', ')}`,
      );
    }
    wave.forEach((step) => remaining.delete(step.stepId));
    waves.push(wave);
  }
  return waves;
}

// Simple node/edge shape a frontend can render directly as a DAG diagram —
// the "workflow visualization metadata" requirement.
export interface WorkflowVisualization {
  nodes: { id: string; agentId: string; label: string }[];
  edges: { from: string; to: string }[];
}

export function buildWorkflowVisualization(definition: WorkflowDefinition): WorkflowVisualization {
  return {
    nodes: definition.steps.map((step) => ({
      id: step.stepId,
      agentId: step.agentId,
      label: definition.stepMetadata?.[step.stepId]?.label ?? step.stepId,
    })),
    edges: definition.steps.flatMap((step) =>
      (step.dependsOn ?? []).map((dep) => ({ from: dep, to: step.stepId })),
    ),
  };
}

export class WorkflowEngine {
  // Runs every wave of a workflow's dependency graph, resolving each
  // step's agent through orchestratorAgentRegistry — the orchestrator
  // itself never performs discovery/risk/compliance/reporting; it only
  // dispatches to whatever agent is registered for a step's agentId.
  async run(
    definition: WorkflowDefinition,
    context: OrchestrationContext,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const waves = buildWaves(definition.steps);
    const results: AgentTaskResult[] = [];
    let hasFailure = false;

    for (const wave of waves) {
      if (options.signal?.aborted) {
        return { status: 'CANCELLED', steps: results };
      }

      const waveResults = await Promise.all(
        wave.map((step) => this.runStep(step, context, options)),
      );
      for (const result of waveResults) {
        results.push(result);
        options.onStepComplete?.(result);
        if (result.status === 'FAILED' || result.status === 'TIMED_OUT') {
          hasFailure = true;
        }
      }
    }

    const status: WorkflowStatus = options.signal?.aborted
      ? 'CANCELLED'
      : hasFailure
        ? results.some((r) => r.status === 'SUCCESS')
          ? 'PARTIAL'
          : 'FAILED'
        : 'COMPLETED';

    return { status, steps: results };
  }

  private async runStep(
    step: WorkflowStepDefinition,
    context: OrchestrationContext,
    options: WorkflowRunOptions,
  ): Promise<AgentTaskResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    options.onStepStart?.(step.stepId);

    if (step.condition && !step.condition(context)) {
      return {
        stepId: step.stepId,
        agentId: step.agentId,
        status: 'SKIPPED',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        attempts: 0,
      };
    }

    if (!orchestratorAgentRegistry.isRegistered(step.agentId)) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      orchestratorTelemetry.recordStepExecution({
        agentId: step.agentId,
        status: 'FAILED',
        durationMs,
      });
      return {
        stepId: step.stepId,
        agentId: step.agentId,
        status: 'FAILED',
        startedAt,
        finishedAt,
        durationMs,
        attempts: 0,
        error: `no agent registered for "${step.agentId}"`,
      };
    }

    const agent = orchestratorAgentRegistry.get(step.agentId);
    let attempts = 0;

    try {
      const output = await withRetry(
        async () => {
          attempts += 1;
          if (options.signal?.aborted) {
            throw new WorkflowCancelledError(step.stepId);
          }
          const execution = agent.execute(step.input ?? {}, context);
          if (!step.timeoutMs) {
            return execution;
          }
          return await Promise.race([
            execution,
            new Promise<never>((_resolve, reject) => {
              setTimeout(
                () => reject(new WorkflowTimeoutError(step.stepId, step.timeoutMs!)),
                step.timeoutMs,
              );
            }),
          ]);
        },
        {
          retries: (step.maxAttempts ?? 1) - 1,
          backoffMs: 250,
          isRetryable: (error) =>
            !(error instanceof WorkflowCancelledError) && isRetryableError(error),
        },
      );

      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      orchestratorTelemetry.recordStepExecution({
        agentId: step.agentId,
        status: 'SUCCESS',
        durationMs,
      });
      return {
        stepId: step.stepId,
        agentId: step.agentId,
        status: 'SUCCESS',
        startedAt,
        finishedAt,
        durationMs,
        attempts,
        output,
      };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      const status: AgentTaskStatus =
        error instanceof WorkflowCancelledError
          ? 'CANCELLED'
          : error instanceof WorkflowTimeoutError
            ? 'TIMED_OUT'
            : 'FAILED';
      orchestratorTelemetry.recordStepExecution({
        agentId: step.agentId,
        status: 'FAILED',
        durationMs,
      });
      return {
        stepId: step.stepId,
        agentId: step.agentId,
        status,
        startedAt,
        finishedAt,
        durationMs,
        attempts,
        error: error instanceof Error ? error.message : 'step execution failed',
      };
    }
  }
}

export const workflowEngine = new WorkflowEngine();
