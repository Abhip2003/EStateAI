import { interrupt } from '@langchain/langgraph';
import { orchestratorAgentRegistry } from '../orchestrator/agent-registry.js';
import {
  buildOrchestrationContext,
  type OrchestrationContext,
  type OrchestrationUser,
  type OrchestrationOrganization,
} from '../orchestrator/execution.context.js';
import type { AgentOutputEntry } from '../orchestrator/execution.context.js';
import { approvalPolicy } from '../approval/approval-policy.js';
import { approvalFoundation } from '../approval/approval.js';
import type { ApprovalRequest } from '../approval/approval.types.js';
import { retrieveKnowledge } from './graph.memory.js';
import type { GraphApprovalState, GraphState } from './state.js';
import { emptyApprovalState } from './state.js';
import type { GraphApprovalInterrupt, GraphApprovalResume } from './graph.types.js';
import { reasoningFoundation } from '../planner/reasoning.js';
import { critic } from '../critic/critic.js';
import { reflectionEngine } from '../reflection/reflection.engine.js';
import type { AgentTaskResult, ExecutionResult } from '../orchestrator/execution.result.js';
import type { WorkflowStatus } from '../orchestrator/types.js';
import type { ReasoningPlan } from '../planner/plan.types.js';
import { captureEpisodeSafely } from '../episodic-memory/index.js';

// Mirrors the duplicate every other orchestrator/planner file in this
// codebase already keeps of this same one-liner (executor.ts,
// reasoning-orchestrator.ts, hitl-orchestrator.ts) — not exported from
// any of them, so each composition root keeps its own copy.
function readConfidence(output: unknown): number | undefined {
  if (output && typeof output === 'object' && 'confidenceScore' in output) {
    const value = (output as Record<string, unknown>).confidenceScore;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function metadataString(state: GraphState, key: string): string {
  const value = state.metadata[key];
  return typeof value === 'string' ? value : '';
}

// Builds a real OrchestrationContext from the graph's own state so a
// wrapped OrchestratorAgent (Discovery/Risk/Compliance/Recommendation/
// Report/Copilot) runs exactly as it does under WorkflowEngine — same
// context shape, same agentOutputs-based cross-agent handoff
// (recommendation.aggregate.ts's resolveHandoffFromContext reads exactly
// this). `executionTrace` is the graph-native equivalent of
// context.agentOutputs, replayed in verbatim on every node call.
function buildContextFromState(state: GraphState): OrchestrationContext {
  const context = buildOrchestrationContext({
    executionId: metadataString(state, 'executionId'),
    user: (state.metadata.user as OrchestrationUser) ?? { id: 'unknown', role: 'USER' },
    organization: state.metadata.organization as OrchestrationOrganization | undefined,
    connectedAccounts: state.connectedAccounts,
    assets: state.asset,
    workflowId: metadataString(state, 'workflowId') || undefined,
    conversationId: metadataString(state, 'conversationId') || undefined,
    metadata: state.metadata,
  });
  context.agentOutputs.push(...state.executionTrace);
  context.toolOutputs.push(...state.toolResults);
  return context;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// A deterministic id (not ApprovalEngine's own random generator) is the
// whole trick that makes gating replay-safe: `interrupt()` pauses by
// *throwing*, so a gated node's own `return` never executes and
// state.approval is never updated before the pause. On every replay
// (including the one that finally resumes past the interrupt) this node
// function runs again from the top, so approval-request creation must be
// idempotent from data already durable *outside* GraphState — the
// ApprovalStore itself — not from a GraphState field that was never
// written. See ApprovalEngine.requestApproval's optional `id` (Phase 27
// addition to Phase 26's engine, additive/backward-compatible).
function deterministicApprovalId(executionId: string, stepId: string): string {
  return `appr-graph-${executionId}-${stepId}`;
}

async function requestOrReuseApproval(
  executionId: string,
  ctx: {
    planId: string;
    workflowId: string;
    stepId: string;
    agentId: string;
    decision: 'AUTO' | 'MANUAL';
  },
): Promise<ApprovalRequest> {
  const id = deterministicApprovalId(executionId, ctx.stepId);
  const existing = await approvalFoundation.approvalEngine.get(id);
  if (existing) return existing;
  return approvalFoundation.approvalEngine.requestApproval({
    id,
    executionId,
    planId: ctx.planId,
    workflowId: ctx.workflowId,
    stepId: ctx.stepId,
    agentId: ctx.agentId,
    decision: ctx.decision,
    reason: `${ctx.agentId} step requires approval per policy (${ctx.decision})`,
  });
}

export interface AgentNodeConfig {
  stateKey: 'discovery' | 'risk' | 'compliance' | 'recommendations' | 'report';
  stepId: string;
  agentId: string;
  buildInput: (state: GraphState) => Record<string, unknown>;
  withKnowledge?: boolean;
}

function traceEntry(
  config: Pick<AgentNodeConfig, 'stepId' | 'agentId'>,
  status: AgentOutputEntry['status'],
  output?: unknown,
): AgentOutputEntry {
  return {
    stepId: config.stepId,
    agentId: config.agentId,
    status,
    output,
    timestamp: new Date().toISOString(),
    confidence: readConfidence(output),
  };
}

// Wraps one existing OrchestratorAgent as a LangGraph node — spec #4
// ("wrap, don't rewrite"). The node's only job is: skip if this step has
// already been *attempted* to a terminal outcome (idempotent replay —
// see graph.checkpoint.ts), gate on ApprovalPolicy exactly like
// ai/approval/hitl-orchestrator.ts does but using LangGraph's own native
// interrupt()/Command primitives instead of HitlOrchestrator's
// condition-based gating (spec #9's own graph-native pause/resume), then
// call `orchestratorAgentRegistry.get(agentId).execute(...)` — the exact
// same call WorkflowEngine.runStep() makes. No agent logic is
// reimplemented here.
//
// The replay guard checks `executionTrace` for a terminal (SUCCESS or
// FAILED) entry, not `state[config.stateKey] !== undefined` — a FAILED
// attempt never sets its stateKey (only SUCCESS does), so checking the
// stateKey alone let a "resume after restart" replay silently re-invoke
// an agent that had already failed, a real bug caught during Phase 27's
// own verification (verify-recovery.ts).
export function makeAgentNode(config: AgentNodeConfig) {
  return async function agentNode(state: GraphState): Promise<Partial<GraphState>> {
    const alreadyAttempted = state.executionTrace.some(
      (entry) =>
        entry.stepId === config.stepId && (entry.status === 'SUCCESS' || entry.status === 'FAILED'),
    );
    if (alreadyAttempted) return {};

    const executionId = metadataString(state, 'executionId');
    const planId = metadataString(state, 'planId');
    const workflowId = metadataString(state, 'workflowId');
    const decision = approvalPolicy.decideForAgent(config.agentId);

    let approval: GraphApprovalState = state.approval ?? emptyApprovalState();

    if (decision !== 'NEVER') {
      let request = await requestOrReuseApproval(executionId, {
        planId,
        workflowId,
        stepId: config.stepId,
        agentId: config.agentId,
        decision,
      });
      approval = {
        ...approval,
        requestIdByStep: { ...approval.requestIdByStep, [config.stepId]: request.id },
      };

      while (request.status === 'PENDING') {
        approval = {
          ...approval,
          pendingApprovalIds: dedupe([...approval.pendingApprovalIds, request.id]),
        };
        const resumeValue = interrupt<GraphApprovalInterrupt, GraphApprovalResume | undefined>({
          approvalId: request.id,
          stepId: config.stepId,
          agentId: config.agentId,
          reason: request.reason,
        });
        if (resumeValue && resumeValue.status !== 'PENDING') {
          request = {
            ...request,
            status: resumeValue.status,
            editedOutput: resumeValue.editedOutput,
          };
          break;
        }
        // resume() was called before a reviewer actually decided —
        // re-check the store (a decision may have landed in between)
        // and, if still nothing, loop back into interrupt() to re-pause.
        const fresh = await approvalFoundation.approvalEngine.get(request.id);
        if (fresh) request = fresh;
      }

      approval = {
        ...approval,
        pendingApprovalIds: approval.pendingApprovalIds.filter((id) => id !== request.id),
      };

      if (request.status === 'REJECTED') {
        return {
          approval: {
            ...approval,
            rejectedStepIds: dedupe([...approval.rejectedStepIds, config.stepId]),
          },
        };
      }
      if (request.editedOutput !== undefined) {
        return {
          [config.stateKey]: request.editedOutput,
          executionTrace: [traceEntry(config, 'SUCCESS', request.editedOutput)],
          approval,
        };
      }
    }

    const context = buildContextFromState(state);
    try {
      const output = await orchestratorAgentRegistry
        .get(config.agentId)
        .execute(config.buildInput(state), context);
      const knowledge = config.withKnowledge ? await retrieveKnowledge(state.asset[0]?.id) : [];
      return {
        [config.stateKey]: output,
        executionTrace: [traceEntry(config, 'SUCCESS', output)],
        approval,
        ...(knowledge.length > 0 ? { knowledge } : {}),
      };
    } catch (error) {
      return {
        executionTrace: [traceEntry(config, 'FAILED', undefined)].map((entry) => ({
          ...entry,
          output: error instanceof Error ? error.message : String(error),
        })),
        approval,
      };
    }
  };
}

export const discoveryNode = makeAgentNode({
  stateKey: 'discovery',
  stepId: 'discovery',
  agentId: 'discovery-agent',
  buildInput: (state) => ({ accountId: state.connectedAccounts[0]?.id }),
});

export const riskNode = makeAgentNode({
  stateKey: 'risk',
  stepId: 'risk',
  agentId: 'risk-agent',
  buildInput: (state) => ({ assetId: state.asset[0]?.id }),
});

export const complianceNode = makeAgentNode({
  stateKey: 'compliance',
  stepId: 'compliance',
  agentId: 'compliance-agent',
  buildInput: (state) => ({ assetId: state.asset[0]?.id }),
});

export const recommendationNode = makeAgentNode({
  stateKey: 'recommendations',
  stepId: 'recommendation',
  agentId: 'recommendation-agent',
  buildInput: (state) => ({ assetId: state.asset[0]?.id }),
  withKnowledge: true,
});

export const reportNode = makeAgentNode({
  stateKey: 'report',
  stepId: 'report',
  agentId: 'report-agent',
  buildInput: (state) => ({ assetId: state.asset[0]?.id }),
  withKnowledge: true,
});

// Copilot's real entry point is conversational (POST /ai/copilot/chat),
// not a DAG step (see copilot.agent.ts's own header comment) — this node
// exists so a future graph *can* use it as a step, appending its answer
// to `messages` rather than one of the analysis slots, exactly mirroring
// how CopilotAgentImpl is "also" an OrchestratorAgent without being part
// of any pre-seeded workflow today.
export const copilotNode = async (state: GraphState): Promise<Partial<GraphState>> => {
  const context = buildContextFromState(state);
  const message = state.messages.at(-1)?.content ?? state.goal;
  try {
    const output = (await orchestratorAgentRegistry.get('copilot-agent').execute(
      {
        assetId: state.asset[0]?.id,
        conversationId: metadataString(state, 'conversationId') || undefined,
        message,
      },
      context,
    )) as { answer: string };
    return {
      messages: [
        { role: 'assistant', content: output.answer, timestamp: new Date().toISOString() },
      ],
      executionTrace: [
        traceEntry({ stepId: 'copilot', agentId: 'copilot-agent' }, 'SUCCESS', output),
      ],
    };
  } catch (error) {
    return {
      executionTrace: [
        {
          ...traceEntry({ stepId: 'copilot', agentId: 'copilot-agent' }, 'FAILED'),
          output: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
};

function toExecutionResult(
  state: GraphState,
  executionId: string,
  workflowId: string,
): ExecutionResult {
  const steps: AgentTaskResult[] = state.executionTrace.map((entry) => ({
    stepId: entry.stepId,
    agentId: entry.agentId,
    status: entry.status,
    startedAt: entry.timestamp,
    finishedAt: entry.timestamp,
    durationMs: entry.durationMs ?? 0,
    attempts: 1,
    output: entry.output,
    error: entry.status === 'FAILED' && typeof entry.output === 'string' ? entry.output : undefined,
  }));
  const data: Record<string, unknown> = {};
  for (const step of steps) if (step.status === 'SUCCESS') data[step.agentId] = step.output;
  const hasFailure = steps.some((step) => step.status === 'FAILED');
  const hasSuccess = steps.some((step) => step.status === 'SUCCESS');
  const status: WorkflowStatus = hasFailure ? (hasSuccess ? 'PARTIAL' : 'FAILED') : 'COMPLETED';
  const now = new Date().toISOString();
  return {
    executionId,
    workflowId,
    status,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    steps,
    data,
  };
}

function fallbackPlan(state: GraphState, workflowId: string): ReasoningPlan {
  return {
    planId: `graph-fallback-${metadataString(state, 'executionId')}`,
    goal: state.goal,
    workflowId,
    steps: [],
    requiredAgents: [],
    requiredTools: [],
    estimatedComplexity: 'LOW',
    estimatedDurationMs: 0,
    confidence: 0.5,
    createdAt: new Date().toISOString(),
  };
}

// Spec #8: "Automatically execute ReflectionEngine after END". LangGraph
// has no literal post-END hook, so this runs as the graph's real last
// node (report -> reflection -> END in graph-builder.ts) — reusing
// Phase 25's Critic + ReflectionEngine + ReflectionStore verbatim, which
// also means GET /ai/reflection/:executionId (Phase 25's own route)
// already works for a graph-executed run with zero changes.
export async function reflectionNode(state: GraphState): Promise<Partial<GraphState>> {
  if (state.reflection !== undefined) return {};

  const executionId = metadataString(state, 'executionId');
  const workflowId = metadataString(state, 'workflowId');
  const planId = metadataString(state, 'planId');

  const plan =
    (planId ? await reasoningFoundation.planStore.get(planId) : undefined) ??
    fallbackPlan(state, workflowId);
  const result = toExecutionResult(state, executionId, workflowId);
  const context = buildContextFromState(state);
  const criticReport = critic.evaluateExecution(result, plan);
  const reflection = reflectionEngine.reflect(result, plan, plan, criticReport, context);
  await reasoningFoundation.reflectionStore.save(reflection);

  captureEpisodeSafely({
    executionId,
    goal: state.goal,
    assetId: state.asset[0]?.id,
    plan,
    result,
    criticReport,
    reflection,
  });

  return { reflection };
}
