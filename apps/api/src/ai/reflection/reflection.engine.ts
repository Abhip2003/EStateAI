import type { ExecutionResult } from '../orchestrator/execution.result.js';
import type { OrchestrationContext } from '../orchestrator/execution.context.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import type { CriticReport } from '../critic/critic.types.js';
import { aggregateConfidence } from '../critic/confidence.js';
import type { DebateReflectionSummary, ReflectionReport } from './reflection.types.js';

function isWeakRecommendationOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const recommendations = (output as Record<string, unknown>).recommendations;
  return Array.isArray(recommendations) && recommendations.length === 0;
}

function isIncompleteReportOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const sections = (output as Record<string, unknown>).sections;
  return Array.isArray(sections) && sections.length === 0;
}

// Runs once after every reasoning-orchestrated workflow (see
// ReasoningOrchestrator.run()) and answers, in plain terms: what
// succeeded, what failed, what evidence is missing, and how much to
// trust the result overall. Distinct from Critic — Critic scores
// individual step/plan outputs; ReflectionEngine synthesizes those
// findings plus the execution's own step data into one persisted,
// human-readable report (GET /ai/reflection/:executionId).
export class ReflectionEngine {
  reflect(
    result: ExecutionResult,
    plan: ReasoningPlan,
    finalPlan: ReasoningPlan,
    criticReport: CriticReport,
    context: OrchestrationContext,
    debate?: DebateReflectionSummary,
  ): ReflectionReport {
    const succeededSteps = result.steps
      .filter((step) => step.status === 'SUCCESS')
      .map((step) => step.stepId);
    const failedSteps = result.steps
      .filter((step) => step.status === 'FAILED' || step.status === 'TIMED_OUT')
      .map((step) => step.stepId);
    const skippedSteps = result.steps
      .filter((step) => step.status === 'SKIPPED')
      .map((step) => step.stepId);

    const weakRecommendations = result.steps
      .filter(
        (step) =>
          step.agentId === 'recommendation-agent' && isWeakRecommendationOutput(step.output),
      )
      .map((step) => step.stepId);
    const incompleteReports = result.steps
      .filter((step) => step.agentId === 'report-agent' && isIncompleteReportOutput(step.output))
      .map((step) => step.stepId);

    const agentConfidences = context.agentOutputs
      .map((entry) => entry.confidence)
      .filter((value): value is number => typeof value === 'number');
    const toolSuccessRatio =
      context.toolOutputs.length === 0
        ? 1
        : context.toolOutputs.filter((entry) => entry.output !== undefined).length /
          context.toolOutputs.length;

    const overallConfidence = aggregateConfidence({
      toolSuccessRatio,
      agentConfidences,
      criticScore: criticReport.score,
    });

    const notes: string[] = [
      `goal "${plan.goal}" mapped to workflow "${plan.workflowId}"`,
      `execution finished with status ${result.status}`,
    ];
    if (failedSteps.length > 0) {
      notes.push(`steps failed: ${failedSteps.join(', ')}`);
    }
    if (skippedSteps.length > 0) {
      notes.push(`steps skipped due to a failed dependency: ${skippedSteps.join(', ')}`);
    }
    if (finalPlan.planId !== plan.planId) {
      notes.push(`plan revised: ${finalPlan.revisionReason}`);
    }

    return {
      executionId: result.executionId,
      planId: plan.planId,
      finalPlanId: finalPlan.planId,
      succeededSteps,
      failedSteps,
      skippedSteps,
      missingEvidence: criticReport.missingEvidence,
      weakRecommendations,
      incompleteReports,
      criticScore: criticReport.score,
      overallConfidence,
      notes,
      createdAt: new Date().toISOString(),
      ...(debate
        ? {
            debateSummary: debate.debateSummary,
            disagreements: debate.disagreements,
            consensusConfidence: debate.consensusConfidence,
          }
        : {}),
    };
  }
}

export const reflectionEngine = new ReflectionEngine();
