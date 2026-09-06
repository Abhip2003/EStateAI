import { AIError } from '../errors/index.js';
import {
  PLANNER_AVAILABLE_AGENTS,
  PLANNER_AVAILABLE_TOOLS,
  type LLMPlan,
  type LLMPlanStep,
  type PlannerAgentId,
  type PlannerToolCategory,
} from './planner.types.js';
import type { LLMPlanDraft, LLMPlanStepDraft } from './planner.parser.js';

// Thrown by validatePlan() for every rejection spec #5 enumerates —
// distinct from ParsingError (a schema/JSON-shape failure, caught in
// planner.parser.ts) so a caller can tell "the model didn't return JSON"
// apart from "the model returned well-formed JSON describing an invalid
// plan".
export class PlanValidationError extends AIError {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`plan is invalid: ${reasons.join('; ')}`);
    this.name = 'PlanValidationError';
    this.reasons = reasons;
  }
}

const AGENT_ALIASES: Record<string, PlannerAgentId> = Object.fromEntries(
  PLANNER_AVAILABLE_AGENTS.flatMap((id) => [
    [id, id],
    [id.replace(/-agent$/, ''), id],
  ]),
);

const TOOL_ALIASES: Record<string, PlannerToolCategory> = Object.fromEntries(
  PLANNER_AVAILABLE_TOOLS.flatMap((id) => [
    [id, id],
    [id.replace(/-/g, ' '), id],
    [id.replace(/-/g, '_'), id],
  ]),
);

function normalizeAgent(raw: string): PlannerAgentId | undefined {
  return AGENT_ALIASES[raw.trim().toLowerCase()];
}

function normalizeTool(raw: string): PlannerToolCategory | undefined {
  return TOOL_ALIASES[raw.trim().toLowerCase()];
}

function detectCycle(steps: LLMPlanStep[]): string[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const cycle: string[] = [];

  function visit(id: string, path: string[]): boolean {
    const status = state.get(id);
    if (status === 'DONE') return false;
    if (status === 'VISITING') {
      cycle.push(...path.slice(path.indexOf(id)), id);
      return true;
    }
    state.set(id, 'VISITING');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (visit(dep, [...path, id])) return true;
    }
    state.set(id, 'DONE');
    return false;
  }

  for (const step of steps) {
    if (visit(step.id, [])) break;
  }
  return cycle;
}

// Spec #5's exact rejection list: unknown agents, unknown tools, cycles,
// duplicate ids, missing dependencies, empty plans, invalid confidence.
// Never partially accepts a plan — one bad step invalidates the whole
// response (the caller, planner.ts, is responsible for retrying/falling
// back), so nothing downstream (buildDynamicGraph) ever sees a
// structurally unsound step list.
export function validatePlan(draft: LLMPlanDraft): LLMPlan {
  const reasons: string[] = [];

  if (draft.steps.length === 0) {
    throw new PlanValidationError(['plan has no steps']);
  }

  if (!(draft.overallConfidence >= 0 && draft.overallConfidence <= 1)) {
    reasons.push(`overallConfidence ${draft.overallConfidence} is not between 0 and 1`);
  }

  const seenIds = new Set<string>();
  const steps: LLMPlanStep[] = draft.steps.map((stepDraft: LLMPlanStepDraft, index) => {
    const id = stepDraft.id?.trim() || `step-${index + 1}`;
    if (seenIds.has(id)) {
      reasons.push(`duplicate step id "${id}"`);
    }
    seenIds.add(id);

    const agent = normalizeAgent(stepDraft.agent);
    if (!agent) {
      reasons.push(`step "${id}" references unknown agent "${stepDraft.agent}"`);
    }

    const tools = (stepDraft.tools ?? []).map((raw) => {
      const tool = normalizeTool(raw);
      if (!tool) reasons.push(`step "${id}" references unknown tool "${raw}"`);
      return tool;
    });

    if (!(stepDraft.confidence >= 0 && stepDraft.confidence <= 1)) {
      reasons.push(`step "${id}" confidence ${stepDraft.confidence} is not between 0 and 1`);
    }

    return {
      id,
      agent: agent ?? 'discovery-agent',
      goal: stepDraft.goal,
      dependsOn: [...new Set(stepDraft.dependsOn ?? [])],
      tools: tools.filter((tool): tool is PlannerToolCategory => tool !== undefined),
      expectedOutput: stepDraft.expectedOutput ?? '',
      confidence: stepDraft.confidence,
    };
  });

  const validIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!validIds.has(dep)) {
        reasons.push(`step "${step.id}" depends on missing step "${dep}"`);
      }
    }
  }

  if (reasons.length === 0) {
    const cycle = detectCycle(steps);
    if (cycle.length > 0) {
      reasons.push(`plan has a dependency cycle: ${cycle.join(' -> ')}`);
    }
  }

  if (reasons.length > 0) {
    throw new PlanValidationError(reasons);
  }

  return { reasoning: draft.reasoning, steps, overallConfidence: draft.overallConfidence };
}
