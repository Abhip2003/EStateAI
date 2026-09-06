import { workflowEngine } from './workflow.engine.js';
import { workflowRegistry } from './workflow.registry.js';
import type { ExecutionPlan } from './planner.js';
import { recordAgentOutput, type OrchestrationContext } from './execution.context.js';
import type { ExecutionResult } from './execution.result.js';
import type { StateManager } from './state.manager.js';
import type { ExecutionHistory } from './execution.history.js';
import { orchestratorTelemetry } from './telemetry.js';
import { indexAgentOutput } from '../shared/knowledge.indexing.js';
import { captureEpisodeSafely } from '../episodic-memory/index.js';

export interface ExecutorRunOptions {
  signal?: AbortSignal;
}

// Every concrete agent (Discovery/Risk/Compliance/Recommendation/Report)
// exposes a top-level `confidenceScore` on its own output type — this
// reads it opportunistically, without importing any agent's types here
// (which would tie the orchestrator layer to its agents). Returns
// undefined for agent outputs that don't expose one, which
// recordAgentOutput already tolerates (durationMs/confidence are both
// optional on AgentOutputEntry).
function readConfidence(output: unknown): number | undefined {
  if (output && typeof output === 'object' && 'confidenceScore' in output) {
    const value = output.confidenceScore;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

// Runs one ExecutionPlan end to end: resolves the underlying
// WorkflowDefinition, drives WorkflowEngine through it, mirrors every step
// result into the shared OrchestrationContext (agentOutputs) and into
// StateManager, then records a summary into ExecutionHistory. This is the
// only class that touches both WorkflowEngine and StateManager/History —
// OrchestratorService (the public-facing entry point) never talks to
// either directly.
export class Executor {
  constructor(
    private readonly stateManager: StateManager,
    private readonly history: ExecutionHistory,
  ) {}

  async run(
    plan: ExecutionPlan,
    context: OrchestrationContext,
    options: ExecutorRunOptions = {},
  ): Promise<ExecutionResult> {
    const definition = workflowRegistry.get(plan.workflowId);
    const startedAt = new Date().toISOString();

    await this.stateManager.create({
      executionId: context.executionId,
      workflowId: plan.workflowId,
      startedAt,
      context,
    });

    const runResult = await workflowEngine.run(definition, context, {
      signal: options.signal,
      onStepStart: (stepId) => {
        void this.stateManager.touchCurrentStep(context.executionId, stepId);
      },
      onStepComplete: (result) => {
        recordAgentOutput(context, {
          stepId: result.stepId,
          agentId: result.agentId,
          status:
            result.status === 'SUCCESS'
              ? 'SUCCESS'
              : result.status === 'SKIPPED'
                ? 'SKIPPED'
                : 'FAILED',
          output: result.output,
          durationMs: result.durationMs,
          confidence: readConfidence(result.output),
        });
        // Automatic Indexing (Phase 23 spec #4) — every successful step's
        // output is embedded and persisted into the Knowledge Store as
        // soon as it completes, with no manual trigger. Fire-and-forget:
        // indexing failures are swallowed inside indexAgentOutput and
        // never affect workflow status, mirroring the Phase 21 Failure
        // Isolation precedent (a downstream agent failing must never roll
        // back an upstream agent's already-successful step).
        if (result.status === 'SUCCESS') {
          void indexAgentOutput(result.agentId, result.output, context);
        }
      },
    });

    const finishedAt = new Date().toISOString();
    const finalState = await this.stateManager.finalize(
      context.executionId,
      runResult.steps,
      runResult.status,
      finishedAt,
      context,
    );

    const data: Record<string, unknown> = {};
    for (const step of runResult.steps) {
      if (step.status === 'SUCCESS') {
        data[step.agentId] = step.output;
      }
    }

    const result: ExecutionResult = {
      executionId: context.executionId,
      workflowId: plan.workflowId,
      status: runResult.status,
      startedAt,
      finishedAt,
      durationMs: finalState.durationMs ?? 0,
      steps: runResult.steps,
      data,
      error: runResult.steps.find((step) => step.error)?.error,
    };

    orchestratorTelemetry.recordWorkflowRun({
      workflowId: plan.workflowId,
      status: result.status,
      durationMs: result.durationMs,
    });
    await this.history.record(result);

    captureEpisodeSafely({
      executionId: context.executionId,
      goal: plan.intent,
      assetId: context.assets[0]?.id,
      result,
    });

    return result;
  }
}
