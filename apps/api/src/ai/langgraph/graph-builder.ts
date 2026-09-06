import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import type { WorkflowDefinition } from '../orchestrator/workflow.engine.js';
import { isRetryableError } from '../utils/retry-policy.js';
import { GraphStateAnnotation, type GraphState } from './state.js';
import {
  discoveryNode,
  riskNode,
  complianceNode,
  recommendationNode,
  reportNode,
  copilotNode,
  reflectionNode,
} from './nodes.js';
import { hasDiscoveredResources, riskScoreExceedsThreshold } from './edges.js';
import { graphTelemetry } from './graph.telemetry.js';
import { GraphError } from './graph-error.js';

// Every existing registered workflow (ai/orchestrator/workflow.registry.ts)
// only ever references these six agent ids — mapping agentId -> the
// already-built node (nodes.ts's makeAgentNode wrappers) is what lets
// buildWorkflowGraph below turn ANY WorkflowDefinition into a runnable
// graph with zero per-workflow hardcoding (spec acceptance criterion
// "LangGraph executes all workflows"). A mutable Map (register()/
// unregister()), not a fixed object literal — mirrors
// orchestratorAgentRegistry/workflowRegistry/approvalPolicy's own
// register()-then-read shape, and is what lets a future 7th agent (or a
// verify script's throwaway fake agent — see verify-parallel.ts/
// verify-checkpoint.ts/verify-hitl-graph.ts/verify-recovery.ts) plug into
// LangGraph without editing this file.
const nodeByAgent = new Map<string, (state: GraphState) => Promise<Partial<GraphState>>>([
  ['discovery-agent', discoveryNode],
  ['risk-agent', riskNode],
  ['compliance-agent', complianceNode],
  ['recommendation-agent', recommendationNode],
  ['report-agent', reportNode],
  // No pre-Phase-27 registered workflow references copilot-agent as a
  // step, so this addition changes nothing for buildWorkflowGraph's
  // existing callers — it exists so Phase 28's LLM Planner (which treats
  // Copilot as one of its six available agents) can place a copilot step
  // in a dynamically generated plan and still resolve to a real node.
  ['copilot-agent', copilotNode],
]);

export function registerGraphNode(
  agentId: string,
  node: (state: GraphState) => Promise<Partial<GraphState>>,
): void {
  nodeByAgent.set(agentId, node);
}

export function unregisterGraphNode(agentId: string): void {
  nodeByAgent.delete(agentId);
}

// LangGraph forbids a node name that collides with a state channel name
// ("X is already being used as a state attribute... cannot also be used
// as a node name") — and workflowRegistry's own stepIds ('discovery',
// 'risk', 'compliance', 'report') are exactly four of GraphState's
// channel names (state.ts). Every node is therefore registered under a
// `-node`-suffixed name (`:` is a reserved character in LangGraph node
// names); `dependsOn`/terminal-step bookkeeping keeps
// using the plain stepId throughout (matching workflowRegistry's own
// data unchanged) and only translates via this helper at the point an
// actual node/edge name is needed.
function nodeName(stepId: string): string {
  return `${stepId}-node`;
}

// LangGraph's own, official per-node RetryPolicy (spec #1 "only use the
// official library, no custom graph implementation") — `retryOn` reuses
// the exact same classifier WorkflowEngine.runStep() uses
// (ai/utils/retry-policy.ts), so a graph-executed step is retried under
// the identical RECOVERABLE/PERMANENT rule a WorkflowEngine-executed step
// already is. `maxAttempts: 1` matches WorkflowEngine's own default (no
// retry unless a step configures more) — this is not a behavior change.
function retryPolicyFor(graphId: string, agentId: string) {
  return {
    maxAttempts: 1,
    retryOn: (error: unknown) => {
      const retry = isRetryableError(error);
      if (retry) graphTelemetry.recordRetry(graphId, agentId);
      return retry;
    },
  };
}

// The subset of CompiledStateGraph's surface every caller in this phase
// actually needs (executor.ts's invoke/getState calls). Declared as a
// structural method-signature interface — not `any` — so
// buildWorkflowGraph's runtime-driven node/edge names (which defeat
// StateGraph's usual compile-time chained type narrowing, since they
// come from `definition.steps`, not string literals) don't leak
// `no-unsafe-*` `any`s into every caller; method-position signatures are
// checked bivariantly, so the real, fully literal-typed graph
// buildConditionalGraph() returns is still assignable here without a
// cast.
export interface CompiledSecurityGraph {
  invoke(input: unknown, config: { configurable: { thread_id: string } }): Promise<GraphState>;
  getState(config: { configurable: { thread_id: string } }): Promise<{
    values: GraphState;
    next: string[];
    tasks: Array<{ interrupts?: Array<{ value?: unknown }> }>;
  }>;
}

interface DynamicGraphBuilder {
  addNode(
    name: string,
    fn: (state: GraphState) => Promise<Partial<GraphState>>,
    options?: { retryPolicy?: unknown },
  ): DynamicGraphBuilder;
  addEdge(from: string, to: string): DynamicGraphBuilder;
  compile(options: { checkpointer: MemorySaver }): CompiledSecurityGraph;
}

// Widest dependency "wave" in a WorkflowDefinition's DAG — the same
// Kahn's-algorithm idea WorkflowEngine.buildWaves() already uses,
// reimplemented here as a small, self-contained topology metric (not
// agent/business logic) purely to report the "parallel branches"
// telemetry field (spec #11) for a graph before it even runs.
export function countMaxParallelBranches(definition: WorkflowDefinition): number {
  const remaining = new Set(definition.steps.map((step) => step.stepId));
  const byId = new Map(definition.steps.map((step) => [step.stepId, step]));
  let max = 0;
  while (remaining.size > 0) {
    const wave = [...remaining].filter((id) =>
      (byId.get(id)?.dependsOn ?? []).every((dep) => !remaining.has(dep)),
    );
    if (wave.length === 0) break; // circular/unresolved — same guard WorkflowEngine's buildWaves() applies
    max = Math.max(max, wave.length);
    wave.forEach((id) => remaining.delete(id));
  }
  return max;
}

// A static `addEdge(dep, step)` only encodes graph *topology* — LangGraph
// runs `step`'s node the moment `dep`'s node completes, whether `dep`
// actually succeeded, failed, or was skipped/rejected. WorkflowEngine's
// own `condition` mechanism gives every pre-Phase-27 workflow the
// opposite, correct behavior (a dependent step is SKIPPED once its
// dependency didn't succeed — see workflow.engine.ts/
// reasoning-orchestrator.ts's buildAdaptiveDefinition/hitl-orchestrator.ts's
// buildGatedDefinition), so buildWorkflowGraph must reproduce it here:
// wrapping each node with a check against its own step's `dependsOn`
// before ever calling the real node function. Caught for real during
// Phase 27's own verification — a rejected MANUAL step's downstream
// dependent still ran, since a rejected node's own `return` never sets
// its state slot but the plain static edge fired anyway.
function withDependencyGate(
  stepId: string,
  agentId: string,
  dependsOn: string[],
  node: (state: GraphState) => Promise<Partial<GraphState>>,
): (state: GraphState) => Promise<Partial<GraphState>> {
  if (dependsOn.length === 0) return node;
  return async (state: GraphState) => {
    const blocked = dependsOn.some(
      (dep) =>
        !state.executionTrace.some((entry) => entry.stepId === dep && entry.status === 'SUCCESS'),
    );
    if (blocked) {
      return {
        executionTrace: [
          { stepId, agentId, status: 'SKIPPED' as const, timestamp: new Date().toISOString() },
        ],
      };
    }
    return node(state);
  };
}

// The minimal step shape buildGraphFromSteps needs — both
// WorkflowStepDefinition (workflowRegistry's own steps) and Phase 28's
// LLMPlanStep (ai/llm-planner/planner.types.ts) satisfy this structurally,
// so neither buildWorkflowGraph nor the LLM Planner's buildDynamicGraph
// needs to convert into a shared concrete type first.
export interface GraphStepLike {
  stepId: string;
  agentId: string;
  dependsOn?: string[];
}

// Shared graph-assembly logic: one node per step (wrapping the existing
// agent via nodes.ts, never reimplementing it), a static edge per
// `dependsOn` entry (which is exactly what gives independent branches —
// e.g. Risk and Compliance both depending only on Discovery — real,
// concurrent LangGraph execution within the same Pregel superstep,
// satisfying spec #6 with zero special-casing), gated by
// withDependencyGate so a step whose dependency didn't succeed is
// SKIPPED rather than run anyway, and every step nothing else depends on
// wired into the reflection node (spec #8) before END. Used by both
// buildWorkflowGraph (a registered WorkflowDefinition) and Phase 28's
// buildDynamicGraph (an ad hoc, validated LLM-generated plan — "no
// predefined workflow id required").
function buildGraphFromSteps(graphId: string, steps: GraphStepLike[]): CompiledSecurityGraph {
  const graph = new StateGraph(GraphStateAnnotation) as unknown as DynamicGraphBuilder;

  for (const step of steps) {
    const node = nodeByAgent.get(step.agentId);
    if (!node) {
      throw new GraphError(
        `no LangGraph node registered for agent "${step.agentId}" (graph "${graphId}")`,
      );
    }
    graph.addNode(
      nodeName(step.stepId),
      withDependencyGate(step.stepId, step.agentId, step.dependsOn ?? [], node),
      { retryPolicy: retryPolicyFor(graphId, step.agentId) },
    );
  }
  graph.addNode(nodeName('reflection'), reflectionNode);

  for (const step of steps) {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      graph.addEdge(START, nodeName(step.stepId));
    } else {
      for (const dep of step.dependsOn) {
        graph.addEdge(nodeName(dep), nodeName(step.stepId));
      }
    }
  }

  const dependedUpon = new Set(steps.flatMap((step) => step.dependsOn ?? []));
  const terminalStepIds = steps
    .filter((step) => !dependedUpon.has(step.stepId))
    .map((step) => step.stepId);
  for (const stepId of terminalStepIds) {
    graph.addEdge(nodeName(stepId), nodeName('reflection'));
  }
  graph.addEdge(nodeName('reflection'), END);

  return graph.compile({ checkpointer: new MemorySaver() });
}

// Converts ANY registered WorkflowDefinition into a compiled LangGraph
// graph — see buildGraphFromSteps for the shared assembly logic.
export function buildWorkflowGraph(definition: WorkflowDefinition): CompiledSecurityGraph {
  return buildGraphFromSteps(definition.id, definition.steps);
}

// Phase 28 (LLM Planner) spec #6: "Convert the validated plan directly
// into a LangGraph graph. No predefined workflow id required." — steps
// come from an LLM-generated, GoalPlanner-independent plan
// (ai/llm-planner/planner.validator.ts's output), not from
// workflowRegistry, so this bypasses buildWorkflowGraph's registry lookup
// entirely while reusing the exact same node-wrapping/dependency-gating/
// reflection-wiring assembly.
export function buildDynamicGraph(graphId: string, steps: GraphStepLike[]): CompiledSecurityGraph {
  return buildGraphFromSteps(graphId, steps);
}

export const CONDITIONAL_GRAPH_ID = 'security-conditional';

// The hand-built demo graph matching spec #5's exact diagram — genuine
// `addConditionalEdges` value-based routing (not the dependency-
// success/failure gating buildWorkflowGraph's plain static edges already
// give every workflow for free): Discovery's OWN reported resourceCount
// decides whether Risk runs at all, and Risk's OWN reported overallScore
// decides whether Compliance runs. Never recomputes either value — see
// edges.ts.
export function buildConditionalGraph(): CompiledSecurityGraph {
  const graph = new StateGraph(GraphStateAnnotation)
    .addNode(nodeName('discovery'), discoveryNode, {
      retryPolicy: retryPolicyFor(CONDITIONAL_GRAPH_ID, 'discovery-agent'),
    })
    .addNode(nodeName('risk'), riskNode, {
      retryPolicy: retryPolicyFor(CONDITIONAL_GRAPH_ID, 'risk-agent'),
    })
    .addNode(nodeName('compliance'), complianceNode, {
      retryPolicy: retryPolicyFor(CONDITIONAL_GRAPH_ID, 'compliance-agent'),
    })
    .addNode(nodeName('recommendation'), recommendationNode, {
      retryPolicy: retryPolicyFor(CONDITIONAL_GRAPH_ID, 'recommendation-agent'),
    })
    .addNode(nodeName('report'), reportNode, {
      retryPolicy: retryPolicyFor(CONDITIONAL_GRAPH_ID, 'report-agent'),
    })
    .addNode(nodeName('reflection'), reflectionNode)
    .addEdge(START, nodeName('discovery'))
    .addConditionalEdges(
      nodeName('discovery'),
      (state) => (hasDiscoveredResources(state) ? nodeName('risk') : nodeName('report')),
      { [nodeName('risk')]: nodeName('risk'), [nodeName('report')]: nodeName('report') },
    )
    .addConditionalEdges(
      nodeName('risk'),
      (state) =>
        riskScoreExceedsThreshold(state) ? nodeName('compliance') : nodeName('recommendation'),
      {
        [nodeName('compliance')]: nodeName('compliance'),
        [nodeName('recommendation')]: nodeName('recommendation'),
      },
    )
    .addEdge(nodeName('compliance'), nodeName('recommendation'))
    .addEdge(nodeName('recommendation'), nodeName('report'))
    .addEdge(nodeName('report'), nodeName('reflection'))
    .addEdge(nodeName('reflection'), END);

  return graph.compile({ checkpointer: new MemorySaver() });
}
