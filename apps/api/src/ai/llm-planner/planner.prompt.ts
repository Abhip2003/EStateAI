import type { LLMMessage } from '../types/common.js';
import { PLANNER_AVAILABLE_AGENTS, PLANNER_AVAILABLE_TOOLS } from './planner.types.js';
import type { PlannerContextSummary, PlannerRunInput, LLMPlan } from './planner.types.js';

const AGENT_DESCRIPTIONS: Record<(typeof PLANNER_AVAILABLE_AGENTS)[number], string> = {
  'discovery-agent': 'Discovers connected-account resources (repositories, organizations).',
  'risk-agent': 'Scores risk for an asset from discovered resources and findings.',
  'compliance-agent': 'Evaluates an asset against compliance policies/frameworks.',
  'recommendation-agent': 'Produces remediation recommendations from risk/compliance findings.',
  'report-agent': 'Compiles a final report summarizing prior steps.',
  'copilot-agent': 'Answers a conversational question about an asset using prior context.',
};

const TOOL_DESCRIPTIONS: Record<(typeof PLANNER_AVAILABLE_TOOLS)[number], string> = {
  'knowledge-search': 'Semantic search over previously indexed findings/reports (pgvector).',
  github: 'Read-only GitHub API calls (repos, orgs, commits, issues, PRs).',
  postgres: 'Read-only queries against the application database.',
  filesystem: 'Read-only filesystem inspection.',
  'web-search': 'General web search.',
};

const RESPONSE_SHAPE = `{
  "reasoning": "<why these steps, in this order>",
  "steps": [
    {
      "id": "step-1",
      "agent": "<one of the available agent ids>",
      "goal": "<what this step should accomplish>",
      "dependsOn": ["<ids of steps this one requires>"],
      "tools": ["<zero or more available tool categories>"],
      "expectedOutput": "<what this step should produce>",
      "confidence": 0.0
    }
  ],
  "overallConfidence": 0.0
}`;

function approvalRulesSection(): string {
  return [
    'Approval rules:',
    '- discovery-agent, risk-agent, compliance-agent, report-agent, copilot-agent: never require manual approval.',
    '- recommendation-agent: automatically approved, but every invocation is still audited.',
    '- A future write-capable tool would require manual approval before running.',
  ].join('\n');
}

function agentsSection(): string {
  return [
    'Available agents:',
    ...PLANNER_AVAILABLE_AGENTS.map((id) => `- ${id}: ${AGENT_DESCRIPTIONS[id]}`),
  ].join('\n');
}

function toolsSection(): string {
  return [
    'Available tools:',
    ...PLANNER_AVAILABLE_TOOLS.map((id) => `- ${id}: ${TOOL_DESCRIPTIONS[id]}`),
  ].join('\n');
}

function graphStateSection(input: PlannerRunInput): string {
  const lines = [
    'Current system state:',
    `- assets: ${input.assets?.map((asset) => asset.id).join(', ') || 'none provided'}`,
    `- connectedAccounts: ${input.connectedAccounts?.map((account) => `${account.provider}:${account.id}`).join(', ') || 'none provided'}`,
    `- conversationId: ${input.conversationId ?? 'none'}`,
  ];
  return lines.join('\n');
}

function memorySection(context: PlannerContextSummary): string {
  return [
    'Memory summary:',
    `- conversation: ${context.conversationSummary}`,
    `- session: ${context.sessionSummary}`,
    `- knowledge: ${context.knowledgeSummary}`,
    `- prior reflection: ${context.reflectionSummary}`,
    `- similar past episodes: ${context.episodeSummary}`,
  ].join('\n');
}

// Builds the LLM Planner's system+user prompt — spec #3's exact section
// list (agents, tools, approval rules, memory summary, current graph
// state, user goal). Returns plain LLMMessage[] (not a PromptTemplate),
// since — unlike every per-agent prompt in ai/agents/*/*.prompts.ts —
// this prompt's shape is fixed code, not natural-language copy a
// non-engineer would tune; PromptTemplate's variable-substitution layer
// would add indirection without buying anything here.
export function buildPlannerPrompt(
  input: PlannerRunInput,
  context: PlannerContextSummary,
): LLMMessage[] {
  const system = [
    'You are the planning engine for a multi-agent digital-asset security platform.',
    'Given a user goal, produce a step-by-step execution plan using only the agents and tools listed below.',
    'Respond with ONLY a single JSON object matching the exact shape shown — no prose, no markdown fences.',
    'Every step must have a unique "id". "dependsOn" must only reference ids of other steps in this same plan.',
    'Never invent an agent or tool outside the lists given. Every confidence value must be between 0 and 1.',
  ].join('\n');

  const user = [
    agentsSection(),
    '',
    toolsSection(),
    '',
    approvalRulesSection(),
    '',
    memorySection(context),
    '',
    graphStateSection(input),
    '',
    `User goal: ${input.goal}`,
    '',
    'Respond with JSON in exactly this shape:',
    RESPONSE_SHAPE,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Spec #8 (Reflection Loop): re-prompts with the previous plan's own
// reasoning/confidence plus why it fell short, asking for a revised plan
// rather than starting from a blank goal a second time.
export function buildRevisionPrompt(
  input: PlannerRunInput,
  context: PlannerContextSummary,
  previousPlan: LLMPlan,
  feedback: string,
): LLMMessage[] {
  const base = buildPlannerPrompt(input, context);
  const revisionNote = [
    'A previous plan for this same goal was executed and scored too low to accept:',
    `Previous reasoning: ${previousPlan.reasoning}`,
    `Previous overallConfidence: ${previousPlan.overallConfidence}`,
    `Feedback: ${feedback}`,
    'Produce a revised plan addressing this feedback. Respond with the same JSON shape.',
  ].join('\n');
  return [...base, { role: 'user', content: revisionNote }];
}

// Feeds a parse/validation failure back to the model as a repair turn —
// wired into ai/parser's parseWithRetry by planner.ts, mirroring
// discovery/risk/etc.'s own LLM-call sites, none of which hand-roll their
// own retry loop either.
export function buildRepairPrompt(previousRaw: string, errorMessage: string): LLMMessage[] {
  return [
    {
      role: 'system',
      content: 'You produced invalid JSON for a plan. Fix it and return ONLY the corrected JSON.',
    },
    { role: 'user', content: `Previous response:\n${previousRaw}\n\nError: ${errorMessage}` },
  ];
}
