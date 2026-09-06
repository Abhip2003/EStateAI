import { workflowRegistry } from '../orchestrator/workflow.registry.js';
import { GraphError } from './graph-error.js';
import {
  buildWorkflowGraph,
  buildConditionalGraph,
  countMaxParallelBranches,
  CONDITIONAL_GRAPH_ID,
  type CompiledSecurityGraph,
} from './graph-builder.js';

export { CONDITIONAL_GRAPH_ID };

// Lazily builds and caches one compiled graph per graphId — built on
// first use (not eagerly at import time) so a workflow registered *after*
// this module loads (verify scripts routinely do this — see
// ai/orchestrator/workflow.registry.ts's own register()/unregister()
// pattern) still gets a graph the first time it's requested. Caching is
// required, not just an optimization: LangGraph's `MemorySaver`
// checkpointer lives inside the compiled graph object, so run() and
// resume() for the same execution MUST resolve to the exact same
// compiled instance or the in-process interrupt/resume story breaks
// immediately (see graph.checkpoint.ts's own header comment on this).
class GraphRegistry {
  private readonly compiled = new Map<string, CompiledSecurityGraph>();
  private readonly parallelBranches = new Map<string, number>();

  getOrBuild(graphId: string): CompiledSecurityGraph {
    const cached = this.compiled.get(graphId);
    if (cached) return cached;

    if (graphId === CONDITIONAL_GRAPH_ID) {
      const graph = buildConditionalGraph();
      this.compiled.set(graphId, graph);
      this.parallelBranches.set(graphId, 1); // sequential/conditional demo graph — no static parallel wave
      return graph;
    }

    if (!workflowRegistry.has(graphId)) {
      throw new GraphError(`no graph or workflow registered with id "${graphId}"`);
    }
    const definition = workflowRegistry.get(graphId);
    const graph = buildWorkflowGraph(definition);
    this.compiled.set(graphId, graph);
    this.parallelBranches.set(graphId, countMaxParallelBranches(definition));
    return graph;
  }

  maxParallelBranches(graphId: string): number {
    return this.parallelBranches.get(graphId) ?? 1;
  }

  // Used by verify scripts that register a throwaway workflow, run it,
  // then unregister it — without this, a second test run reusing the
  // same graphId would resolve to a stale compiled graph built from the
  // first test's (already unregistered) WorkflowDefinition.
  invalidate(graphId: string): void {
    this.compiled.delete(graphId);
    this.parallelBranches.delete(graphId);
  }
}

export const graphRegistry = new GraphRegistry();

// Same "not an AI call" keyword-matching spirit as
// ai/orchestrator/planner.ts's own intent resolution — goals mentioning
// "conditional" route to the hand-built spec #5 demo graph; everything
// else runs through whichever workflow ai/orchestrator/planner.ts (Phase
// 17, unchanged) already resolved the goal to.
export function resolveGraphId(goal: string, workflowId: string): string {
  return /conditional/i.test(goal) ? CONDITIONAL_GRAPH_ID : workflowId;
}
