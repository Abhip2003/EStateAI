import type {
  OrchestrationUser,
  OrchestrationOrganization,
  ConnectedAccountRef,
  AssetRef,
} from '../orchestrator/execution.context.js';

// The six agents Phase 27's LangGraph module can already run as a node
// (ai/langgraph/graph-builder.ts's nodeByAgent) — the LLM Planner never
// invents a seventh; a plan referencing anything else is rejected by
// planner.validator.ts, never silently coerced.
export const PLANNER_AVAILABLE_AGENTS = [
  'discovery-agent',
  'risk-agent',
  'compliance-agent',
  'recommendation-agent',
  'report-agent',
  'copilot-agent',
] as const;
export type PlannerAgentId = (typeof PLANNER_AVAILABLE_AGENTS)[number];

// Tool *categories*, not literal registered tool names
// (ai/tools/agent-tool-access.ts lists ~30 concrete tool names) — the
// spec's own prompt section #3 lists "Knowledge Search / GitHub /
// Postgres / Filesystem / Web Search", the same five families
// ai/tools/builtin/index.ts registers. The LLM reasons about which
// family a step needs; which concrete tool within that family actually
// gets called remains entirely up to the wrapped agent's own executor
// (unchanged, per the "wrap don't rewrite" rule that governs this whole
// phase), exactly as it already does under WorkflowEngine/LangGraph.
export const PLANNER_AVAILABLE_TOOLS = [
  'knowledge-search',
  'github',
  'postgres',
  'filesystem',
  'web-search',
] as const;
export type PlannerToolCategory = (typeof PLANNER_AVAILABLE_TOOLS)[number];

export interface LLMPlanStep {
  id: string;
  agent: PlannerAgentId;
  goal: string;
  dependsOn: string[];
  tools: PlannerToolCategory[];
  expectedOutput: string;
  confidence: number;
}

// The validated, structured output every LLM Planner call produces —
// spec #4's exact shape (reasoning/steps/overallConfidence), with `id`
// added to each step (see planner.validator.ts) since dependsOn/cycle
// detection/dynamic-graph construction all need a stable step identity
// the spec's own illustrative JSON doesn't show one for.
export interface LLMPlan {
  reasoning: string;
  steps: LLMPlanStep[];
  overallConfidence: number;
}

export interface PlannerRunInput {
  goal: string;
  user: OrchestrationUser;
  organization?: OrchestrationOrganization;
  connectedAccounts?: ConnectedAccountRef[];
  assets?: AssetRef[];
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export type PlanSource = 'llm' | 'cache' | 'fallback';

// Persisted/returned record — spec #10's telemetry fields folded directly
// onto the record GET /ai/planner/history lists, rather than a separate
// lookup, since every one of those fields is scoped to exactly one
// planning call.
export interface LLMPlanRecord {
  planId: string;
  goal: string;
  assetId?: string;
  plan: LLMPlan;
  source: PlanSource;
  model: string;
  cacheHit: boolean;
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  reasoningLength: number;
  createdAt: string;
  revisionOf?: string;
  revisionReason?: string;
}

export interface PlannerContextSummary {
  conversationSummary: string;
  sessionSummary: string;
  knowledgeSummary: string;
  reflectionSummary: string;
  knowledgeVersion: string;
  // Phase 30 — a summary of similar past episodes (episodic-memory)
  // relevant to this goal/asset, appended additively alongside the four
  // Phase 28 summaries above; every existing reader of
  // PlannerContextSummary keeps compiling unchanged.
  episodeSummary: string;
}
