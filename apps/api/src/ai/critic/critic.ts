import type { AgentTaskResult, ExecutionResult } from '../orchestrator/execution.result.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import type { CriticFinding, CriticReport } from './critic.types.js';

// Treats an output whose only array-valued field(s) are all empty as
// "no evidence" — mirrors the same heuristic copilot.executor.ts's
// summarizeToolOutput() uses to decide whether a tool call actually said
// anything. A step can be SUCCESS by WorkflowEngine's definition (no
// exception thrown) yet still carry no usable evidence.
function isEmptyEvidence(output: unknown): boolean {
  if (output === undefined || output === null) return true;
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === 'object') {
    const arrays = Object.values(output as Record<string, unknown>).filter(Array.isArray);
    return arrays.length > 0 && arrays.every((array) => array.length === 0);
  }
  return false;
}

// Evaluates agent outputs, plan quality, and missing evidence —
// independently of whether WorkflowEngine itself reports
// SUCCESS/PARTIAL/FAILED for the run as a whole. ReflectionEngine
// consumes CriticReport to build its higher-level, persisted summary;
// Critic itself never persists anything.
export class Critic {
  evaluateStep(step: AgentTaskResult): CriticFinding[] {
    if (step.status === 'FAILED' || step.status === 'TIMED_OUT') {
      return [
        {
          stepId: step.stepId,
          agentId: step.agentId,
          severity: 'CRITICAL',
          message: step.error ?? `${step.agentId} step ${step.status.toLowerCase()}`,
        },
      ];
    }
    if (step.status === 'SKIPPED') {
      return [
        {
          stepId: step.stepId,
          agentId: step.agentId,
          severity: 'WARNING',
          message: `${step.agentId} step skipped (an upstream dependency did not succeed)`,
        },
      ];
    }
    if (isEmptyEvidence(step.output)) {
      return [
        {
          stepId: step.stepId,
          agentId: step.agentId,
          severity: 'WARNING',
          message: `${step.agentId} succeeded but returned no evidence`,
        },
      ];
    }
    return [];
  }

  evaluatePlan(plan: ReasoningPlan): CriticFinding[] {
    const findings: CriticFinding[] = [];
    if (plan.steps.length === 0) {
      findings.push({ severity: 'CRITICAL', message: 'plan has no steps' });
    }
    if (plan.confidence < 0.6) {
      findings.push({
        severity: 'WARNING',
        message: `plan confidence is low (${plan.confidence.toFixed(2)}) for goal "${plan.goal}"`,
      });
    }
    return findings;
  }

  evaluateExecution(result: ExecutionResult, plan?: ReasoningPlan): CriticReport {
    const findings = result.steps.flatMap((step) => this.evaluateStep(step));
    if (plan) findings.push(...this.evaluatePlan(plan));

    const missingEvidence = result.steps
      .filter((step) => step.status === 'SUCCESS' && isEmptyEvidence(step.output))
      .map((step) => `${step.agentId} (${step.stepId})`);

    const successCount = result.steps.filter((step) => step.status === 'SUCCESS').length;
    const successRatio = result.steps.length === 0 ? 1 : successCount / result.steps.length;
    const criticalCount = findings.filter((finding) => finding.severity === 'CRITICAL').length;
    const warningCount = findings.filter((finding) => finding.severity === 'WARNING').length;
    const penalty = criticalCount * 0.25 + warningCount * 0.1;

    return {
      score: Math.max(0, Math.min(1, successRatio - penalty)),
      findings,
      missingEvidence,
    };
  }
}

export const critic = new Critic();
