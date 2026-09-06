import { orchestratorAgentRegistry } from '../orchestrator/agent-registry.js';
import {
  buildOrchestrationContext,
  recordAgentOutput,
  type OrchestrationContext,
} from '../orchestrator/execution.context.js';
import type { AgentTaskResult, ExecutionResult } from '../orchestrator/execution.result.js';
import type { RiskAgentOutput } from '../agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../agents/recommendation/recommendation.interface.js';
import type { CopilotAgentOutput } from '../agents/copilot/copilot.interface.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import { reasoningFoundation } from '../planner/reasoning.js';
import { critic } from '../critic/critic.js';
import { reflectionEngine } from '../reflection/reflection.engine.js';
import { isHighOrAboveRisk, deriveConflicts } from './consensus.scoring.js';
import { consensusEngine } from './consensus.engine.js';
import { consensusStore } from './consensus.js';
import { debateMemory } from './debate.memory.js';
import { debateTelemetry } from './debate.telemetry.js';
import { buildDebateSummaryMessage } from './debate.prompt.js';
import { captureEpisodeSafely } from '../episodic-memory/index.js';
import type {
  DebateParticipantId,
  DebateRecord,
  DebateRunInput,
  DebateTriggerReason,
  DebateTurn,
} from './debate.types.js';

const CONFIDENCE_THRESHOLD = 0.6;

function generateDebateId(): string {
  return `debate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readConfidence(output: unknown): number {
  if (output && typeof output === 'object' && 'confidenceScore' in output) {
    const value = (output as Record<string, unknown>).confidenceScore;
    return typeof value === 'number' ? value : 0.7;
  }
  return 0.7;
}

function makeTurn(
  agentId: DebateParticipantId,
  output: unknown,
  critiques?: DebateParticipantId,
): DebateTurn {
  return {
    agentId,
    critiques,
    output,
    confidence: readConfidence(output),
    timestamp: new Date().toISOString(),
  };
}

// Spec #5's exact trigger list: overall confidence < threshold, OR
// multiple agents disagree, OR risk >= HIGH. Reuses
// consensus.scoring.ts's deriveConflicts()/isHighOrAboveRisk() so the
// same structural checks that will later appear in the final
// ConsensusReport's `conflicts` are also what decides whether a full
// debate (Copilot summarization + consensus computation) is worth
// running at all.
function evaluateTrigger(
  risk: RiskAgentOutput,
  compliance: ComplianceAgentOutput,
  recommendation: RecommendationAgentOutput,
): { triggered: boolean; reasons: DebateTriggerReason[] } {
  const reasons: DebateTriggerReason[] = [];

  const averageConfidence =
    (risk.confidenceScore + compliance.confidenceScore + recommendation.confidenceScore) / 3;
  if (averageConfidence < CONFIDENCE_THRESHOLD) reasons.push('LOW_CONFIDENCE');

  if (deriveConflicts(risk, compliance, recommendation).length > 0) reasons.push('DISAGREEMENT');

  if (isHighOrAboveRisk(risk.businessImpact)) reasons.push('HIGH_RISK');

  return { triggered: reasons.length > 0, reasons };
}

function fallbackPlan(debateId: string, assetId: string, participants: string[]): ReasoningPlan {
  return {
    planId: `debate-plan-${debateId}`,
    goal: `multi-agent debate for asset ${assetId}`,
    workflowId: 'debate',
    steps: participants.map((agentId, index) => ({
      stepId: agentId,
      agentId,
      dependsOn: index === 0 ? [] : [participants[index - 1]],
      tools: [],
    })),
    requiredAgents: participants,
    requiredTools: [],
    estimatedComplexity: 'MEDIUM',
    estimatedDurationMs: 0,
    confidence: 0.7,
    createdAt: new Date().toISOString(),
  };
}

function toExecutionResult(debateId: string, turns: DebateTurn[]): ExecutionResult {
  const steps: AgentTaskResult[] = turns.map((turn) => ({
    stepId: turn.agentId,
    agentId: turn.agentId,
    status: 'SUCCESS',
    startedAt: turn.timestamp,
    finishedAt: turn.timestamp,
    durationMs: 0,
    attempts: 1,
    output: turn.output,
  }));
  const data: Record<string, unknown> = {};
  for (const turn of turns) data[turn.agentId] = turn.output;
  return {
    executionId: debateId,
    workflowId: 'debate',
    status: 'COMPLETED',
    startedAt: turns[0]?.timestamp ?? new Date().toISOString(),
    finishedAt: turns.at(-1)?.timestamp ?? new Date().toISOString(),
    durationMs: 0,
    steps,
    data,
  };
}

// Coordinates the whole debate flow (spec #3): Risk -> Recommendation
// (critiques Risk) -> Compliance (critiques Recommendation) -> [if
// triggered] Copilot summarizes -> Consensus Engine. Every participant
// call is `orchestratorAgentRegistry.get(agentId).execute(input, context)`
// — the exact same call every other execution engine in this codebase
// makes (WorkflowEngine.runStep(), LangGraph's makeAgentNode(),
// LLMPlannerExecutor's dynamic graph) — so no agent's business logic is
// reimplemented, and no participant's output is ever mutated by this
// class or by another participant; each only ever reads what the shared
// OrchestrationContext already recorded.
export class DebateEngine {
  async run(input: DebateRunInput): Promise<DebateRecord> {
    const debateId = generateDebateId();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();

    const context: OrchestrationContext = buildOrchestrationContext({
      executionId: debateId,
      user: input.user,
      organization: input.organization,
      assets: [{ id: input.assetId }],
      conversationId: input.conversationId,
      workflowId: 'debate',
      metadata: input.metadata,
    });

    const turns: DebateTurn[] = [];

    const riskOutput = (await orchestratorAgentRegistry
      .get('risk-agent')
      .execute({ assetId: input.assetId }, context)) as RiskAgentOutput;
    recordAgentOutput(context, {
      stepId: 'risk-agent',
      agentId: 'risk-agent',
      status: 'SUCCESS',
      output: riskOutput,
      confidence: riskOutput.confidenceScore,
    });
    turns.push(makeTurn('risk-agent', riskOutput));

    const recommendationOutput = (await orchestratorAgentRegistry
      .get('recommendation-agent')
      .execute({ assetId: input.assetId }, context)) as RecommendationAgentOutput;
    recordAgentOutput(context, {
      stepId: 'recommendation-agent',
      agentId: 'recommendation-agent',
      status: 'SUCCESS',
      output: recommendationOutput,
      confidence: recommendationOutput.confidenceScore,
    });
    turns.push(makeTurn('recommendation-agent', recommendationOutput, 'risk-agent'));

    const complianceOutput = (await orchestratorAgentRegistry
      .get('compliance-agent')
      .execute({ assetId: input.assetId }, context)) as ComplianceAgentOutput;
    recordAgentOutput(context, {
      stepId: 'compliance-agent',
      agentId: 'compliance-agent',
      status: 'SUCCESS',
      output: complianceOutput,
      confidence: complianceOutput.confidenceScore,
    });
    turns.push(makeTurn('compliance-agent', complianceOutput, 'recommendation-agent'));

    const trigger = evaluateTrigger(riskOutput, complianceOutput, recommendationOutput);

    if (!trigger.triggered) {
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAtMs;
      const record: DebateRecord = {
        debateId,
        assetId: input.assetId,
        triggered: false,
        triggerReasons: [],
        turns,
        startedAt,
        finishedAt,
        durationMs,
      };
      await debateMemory.save(record);
      debateTelemetry.recordDebate({
        triggered: false,
        durationMs,
        participants: turns.length,
        messages: turns.length,
      });
      captureEpisodeSafely({
        executionId: debateId,
        goal: `multi-agent debate for asset ${input.assetId}`,
        assetId: input.assetId,
        result: toExecutionResult(debateId, turns),
        debate: record,
      });
      return record;
    }

    const copilotOutput = (await orchestratorAgentRegistry.get('copilot-agent').execute(
      {
        assetId: input.assetId,
        conversationId: input.conversationId ?? debateId,
        message: buildDebateSummaryMessage(input.assetId),
      },
      context,
    )) as CopilotAgentOutput;
    recordAgentOutput(context, {
      stepId: 'copilot-agent',
      agentId: 'copilot-agent',
      status: 'SUCCESS',
      output: copilotOutput,
      confidence: copilotOutput.confidenceScore,
    });
    turns.push(makeTurn('copilot-agent', copilotOutput));

    const consensus = consensusEngine.compute({
      debateId,
      assetId: input.assetId,
      risk: riskOutput,
      compliance: complianceOutput,
      recommendation: recommendationOutput,
      copilotConfidence: copilotOutput.confidenceScore,
    });
    await consensusStore.save(consensus);

    // Reflection Integration (spec #6) — reuses Phase 25's Critic +
    // ReflectionEngine + ReflectionStore verbatim; GET
    // /ai/reflection/:executionId (unchanged) already reads this back
    // using the debateId as the executionId.
    const participants: DebateParticipantId[] = [
      'risk-agent',
      'recommendation-agent',
      'compliance-agent',
      'copilot-agent',
    ];
    const plan = fallbackPlan(debateId, input.assetId, participants);
    const result = toExecutionResult(debateId, turns);
    const criticReport = critic.evaluateExecution(result, plan);
    const reflection = reflectionEngine.reflect(result, plan, plan, criticReport, context, {
      debateSummary: copilotOutput.answer,
      disagreements: consensus.conflicts.map((conflict) => conflict.description),
      consensusConfidence: consensus.confidence,
    });
    await reasoningFoundation.reflectionStore.save(reflection);

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const record: DebateRecord = {
      debateId,
      assetId: input.assetId,
      triggered: true,
      triggerReasons: trigger.reasons,
      turns,
      consensus,
      startedAt,
      finishedAt,
      durationMs,
    };
    await debateMemory.save(record);

    const averageBaseConfidence =
      (riskOutput.confidenceScore +
        complianceOutput.confidenceScore +
        recommendationOutput.confidenceScore) /
      3;
    debateTelemetry.recordDebate({
      triggered: true,
      durationMs,
      participants: turns.length,
      messages: turns.length,
      agreementScore: consensus.agreementScore,
      confidenceDelta: consensus.confidence - averageBaseConfidence,
    });

    captureEpisodeSafely({
      executionId: debateId,
      goal: plan.goal,
      assetId: input.assetId,
      plan,
      result,
      criticReport,
      reflection,
      debate: record,
      consensus,
    });

    return record;
  }
}

export const debateEngine = new DebateEngine();
