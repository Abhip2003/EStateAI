import { redis } from '../../cache/redis.js';
import { RedisMemoryStore } from '../memory/redis-memory-store.js';
import type { MemoryStore } from '../interfaces/memory-store.interface.js';
import { aiFoundation } from '../foundation.js';
import { aiConfig } from '../config/index.js';
import type { LLMMessage } from '../types/common.js';
import { goalPlanner } from '../planner/goal-planner.js';
import { buildPlannerPrompt, buildRevisionPrompt, buildRepairPrompt } from './planner.prompt.js';
import { gatherPlannerContext } from './planner.memory.js';
import { tryParsePlan } from './planner.parser.js';
import { validatePlan, PlanValidationError } from './planner.validator.js';
import { PlannerCache, type PlannerCacheKeyInput } from './planner.cache.js';
import { plannerTelemetry } from './planner.telemetry.js';
import { PLANNER_AVAILABLE_AGENTS } from './planner.types.js';
import type {
  LLMPlan,
  LLMPlanRecord,
  LLMPlanStep,
  PlannerAgentId,
  PlannerRunInput,
  PlannerToolCategory,
} from './planner.types.js';

const MAX_REPAIR_ATTEMPTS = 2;
const HISTORY_KEY = 'llm-planner:history';

function generatePlanId(): string {
  return `llmplan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Best-effort mapping from a real registered tool name
// (ai/tools/agent-tool-access.ts) to the planner's own five tool
// categories — used only by fallbackPlan below, to keep a
// GoalPlanner-derived fallback's `tools` field consistent with what an
// LLM-generated plan would say.
function toolCategoryFor(toolName: string): PlannerToolCategory | undefined {
  if (toolName.startsWith('github_')) return 'github';
  if (toolName.startsWith('postgres_')) return 'postgres';
  if (toolName.startsWith('knowledge_')) return 'knowledge-search';
  if (toolName.startsWith('fs_')) return 'filesystem';
  if (toolName.startsWith('web_search')) return 'web-search';
  return undefined;
}

// Deterministic fallback used whenever the LLM path is unavailable (no
// configured provider — the expected state of most environments running
// this codebase, see discovery.executor.ts's own generateSummary()) or
// the model's response never parses/validates within
// MAX_REPAIR_ATTEMPTS. Reuses the existing, deterministic GoalPlanner
// (ai/planner/goal-planner.ts) rather than duplicating workflow-selection
// logic — the LLM Planner still *always* returns a usable, validated
// LLMPlan, it just isn't LLM-authored this time.
function isPlannerAgentId(agentId: string): agentId is PlannerAgentId {
  return (PLANNER_AVAILABLE_AGENTS as readonly string[]).includes(agentId);
}

function fallbackPlan(input: PlannerRunInput): LLMPlan {
  const reasoningPlan = goalPlanner.createPlan(input.goal, input.metadata);
  // Every registered production workflow (workflow.registry.ts) only ever
  // uses the same five real agent ids the LLM Planner already knows about,
  // so this filter is a no-op in practice — but workflowRegistry is a
  // general-purpose, mutable registry (see graph-builder.ts's own
  // register()/unregister() pattern), so a step naming an agent outside
  // PLANNER_AVAILABLE_AGENTS is dropped here rather than silently mistyped
  // through `as PlannerAgentId`, which previously let a step with an
  // unrecognized agent slip past this function only to make
  // buildDynamicGraph produce zero runnable nodes and fail with an opaque
  // LangGraph "reflection-node is not reachable" error (caught during this
  // phase's own verification — see planner.executor.ts's
  // PlannerGraphInputError for the matching defense at the graph-build
  // boundary).
  const steps: LLMPlanStep[] = reasoningPlan.steps
    .filter((step) => isPlannerAgentId(step.agentId))
    .map((step) => ({
      id: step.stepId,
      agent: step.agentId as PlannerAgentId,
      goal: `${step.agentId} performs its role for: ${input.goal}`,
      dependsOn: step.dependsOn,
      tools: [
        ...new Set(
          step.tools.map(toolCategoryFor).filter((t): t is PlannerToolCategory => t !== undefined),
        ),
      ],
      expectedOutput: `${step.agentId} output`,
      confidence: reasoningPlan.confidence,
    }));
  return {
    reasoning: `Deterministic fallback plan derived from GoalPlanner for workflow "${reasoningPlan.workflowId}" (no usable LLM response).`,
    steps,
    overallConfidence: reasoningPlan.confidence,
  };
}

interface GenerationOutcome {
  plan: LLMPlan;
  source: 'llm' | 'fallback';
  promptTokens: number;
  completionTokens: number;
}

// Calls the LLM, parses + validates the response, and repairs a malformed
// response up to MAX_REPAIR_ATTEMPTS times (spec #4's "never execute
// free-form text, always validate") before giving up and falling back —
// mirrors ai/parser's parseWithRetry, but validation failures (not just
// parse failures) also trigger a repair turn here, since
// planner.validator.ts's rejections are just as actionable a signal to
// feed back to the model as a JSON syntax error.
async function generateValidPlan(
  messages: LLMMessage[],
  input: PlannerRunInput,
  model: string,
): Promise<GenerationOutcome> {
  let promptTokens = 0;
  let completionTokens = 0;
  let currentMessages = messages;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS + 1; attempt += 1) {
    let raw: string;
    try {
      const response = await aiFoundation.llmClient.generate({
        model,
        messages: currentMessages,
        maxTokens: 1200,
        temperature: 0.2,
      });
      promptTokens += response.usage.promptTokens;
      completionTokens += response.usage.completionTokens;
      raw = response.text;
    } catch {
      // No configured LLM provider (e.g. no OPENAI_API_KEY) is expected
      // in most environments running this codebase today — graceful
      // degradation to the deterministic fallback, never a failed plan.
      break;
    }

    const parsed = tryParsePlan(raw);
    if (parsed.success && parsed.data) {
      try {
        const plan = validatePlan(parsed.data);
        return { plan, source: 'llm', promptTokens, completionTokens };
      } catch (error) {
        if (attempt > MAX_REPAIR_ATTEMPTS) break;
        const reason = error instanceof PlanValidationError ? error.message : 'invalid plan';
        currentMessages = [...messages, ...buildRepairPrompt(raw, reason)];
        continue;
      }
    }
    if (attempt > MAX_REPAIR_ATTEMPTS) break;
    currentMessages = [
      ...messages,
      ...buildRepairPrompt(raw, parsed.error?.message ?? 'invalid JSON'),
    ];
  }

  return { plan: fallbackPlan(input), source: 'fallback', promptTokens, completionTokens };
}

// Append-only plan history, backed by the same injected MemoryStore
// pattern as every other store in this codebase — powers GET
// /ai/planner/history (spec #11). Kept inside planner.ts (rather than a
// dedicated planner.store.ts) since the spec's own llm-planner/ file list
// doesn't name one and a plan record's whole lifecycle (create, cache,
// list) is small enough to live alongside LLMPlanner itself.
export class PlannerHistoryStore {
  constructor(private readonly store: MemoryStore) {}

  async record(entry: LLMPlanRecord): Promise<void> {
    await this.store.append(HISTORY_KEY, entry);
  }

  async list(limit = 50): Promise<LLMPlanRecord[]> {
    const all = await this.store.getList<LLMPlanRecord>(HISTORY_KEY);
    return all.slice(-limit).reverse();
  }
}

// Coordinates the whole LLM Planner flow: gather memory/knowledge context
// (planner.memory.ts) -> check cache (planner.cache.ts) -> prompt
// (planner.prompt.ts) -> generate + parse + validate (planner.parser.ts/
// planner.validator.ts, with repair retries) -> record telemetry
// (planner.telemetry.ts) -> persist to cache + history. Distinct from
// GoalPlanner (ai/planner/goal-planner.ts, unchanged) — that planner
// deterministically selects a *registered* workflow; this one reasons
// freely and its output becomes an ad hoc graph via
// planner.executor.ts's buildDynamicGraph, no registered workflow id
// required.
export class LLMPlanner {
  constructor(
    private readonly cache: PlannerCache,
    private readonly history: PlannerHistoryStore,
  ) {}

  async plan(input: PlannerRunInput): Promise<LLMPlanRecord> {
    const context = await gatherPlannerContext(input);
    const assetId = input.assets?.[0]?.id;
    const model = aiConfig.defaultModel;
    const cacheKeyInput: PlannerCacheKeyInput = {
      goal: input.goal,
      assetId,
      knowledgeVersion: context.knowledgeVersion,
      model,
    };

    const cached = await this.cache.get(cacheKeyInput);
    if (cached) {
      const record: LLMPlanRecord = {
        ...cached,
        planId: generatePlanId(),
        cacheHit: true,
        source: 'cache',
        createdAt: new Date().toISOString(),
      };
      plannerTelemetry.recordPlan({
        source: record.source,
        cacheHit: true,
        iterations: record.iterations,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        confidence: record.plan.overallConfidence,
        reasoningLength: record.plan.reasoning.length,
      });
      await this.history.record(record);
      return record;
    }

    const startedAtMs = Date.now();
    const messages = buildPlannerPrompt(input, context);
    const outcome = await generateValidPlan(messages, input, model);
    const record = this.toRecord(input, assetId, model, outcome, Date.now() - startedAtMs, 1);

    await this.cache.set(cacheKeyInput, record);
    await this.history.record(record);
    plannerTelemetry.recordPlan({
      source: record.source,
      cacheHit: false,
      iterations: record.iterations,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      latencyMs: record.latencyMs,
      confidence: record.plan.overallConfidence,
      reasoningLength: record.plan.reasoning.length,
    });
    return record;
  }

  // Spec #8 (Reflection Loop): re-plans given the previous plan and a
  // human-readable reason it fell short. Never reads/writes the cache —
  // a revision is, by definition, a response to this specific run's own
  // execution feedback, not something a later identical goal should
  // reuse verbatim.
  async revise(
    input: PlannerRunInput,
    previousPlan: LLMPlan,
    feedback: string,
    iteration: number,
  ): Promise<LLMPlanRecord> {
    const context = await gatherPlannerContext(input);
    const model = aiConfig.defaultModel;
    const startedAtMs = Date.now();
    const messages = buildRevisionPrompt(input, context, previousPlan, feedback);
    const outcome = await generateValidPlan(messages, input, model);
    const record = this.toRecord(
      input,
      input.assets?.[0]?.id,
      model,
      outcome,
      Date.now() - startedAtMs,
      iteration,
    );
    record.revisionReason = feedback;
    await this.history.record(record);
    plannerTelemetry.recordPlan({
      source: record.source,
      cacheHit: false,
      iterations: record.iterations,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      latencyMs: record.latencyMs,
      confidence: record.plan.overallConfidence,
      reasoningLength: record.plan.reasoning.length,
    });
    return record;
  }

  private toRecord(
    input: PlannerRunInput,
    assetId: string | undefined,
    model: string,
    outcome: GenerationOutcome,
    latencyMs: number,
    iterations: number,
  ): LLMPlanRecord {
    return {
      planId: generatePlanId(),
      goal: input.goal,
      assetId,
      plan: outcome.plan,
      source: outcome.source,
      model,
      cacheHit: false,
      iterations,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      latencyMs,
      reasoningLength: outcome.plan.reasoning.length,
      createdAt: new Date().toISOString(),
    };
  }
}

const memoryStore = new RedisMemoryStore(redis);
export const plannerCache = new PlannerCache(memoryStore);
export const plannerHistoryStore = new PlannerHistoryStore(memoryStore);
export const llmPlanner = new LLMPlanner(plannerCache, plannerHistoryStore);
