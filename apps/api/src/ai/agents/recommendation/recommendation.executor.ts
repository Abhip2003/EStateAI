import type { AIContext } from '../../types/context.types.js';
import { recordExecutionStep } from '../../context/ai-context-builder.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { withRetry } from '../../utils/retry.js';
import { ToolExecutionError } from '../../errors/index.js';
import {
  type OrchestrationContext,
  recordAgentOutput,
  recordDecision,
} from '../../orchestrator/execution.context.js';
import { MissingRecommendationTargetError } from './recommendation.errors.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { generateRecommendationSummary } from './recommendation.summary.js';
import {
  resolveHandoffFromContext,
  mergeRecommendations,
  prioritizeRecommendations,
  handoffSource,
  type RecommendationEngineRow,
} from './recommendation.aggregate.js';
import type { Finding } from '../../shared/finding.types.js';
import type {
  IRecommendationExecutor,
  RecommendationExecutorInput,
  RecommendationAgentOutput,
  IRecommendationMemory,
} from './recommendation.interface.js';
import type { RecommendationAgentTelemetry } from './recommendation.telemetry.js';
import type { RecommendationHandoffSource, RecommendationView } from './recommendation.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return !message.includes('not found') && !message.includes('do not have access');
}

function confidenceFor(input: { success: boolean; count: number; warningCount: number }): number {
  if (!input.success) return 0;
  if (input.warningCount > 0) return 0.75;
  return input.count > 0 ? 1 : 0.9;
}

interface FindingLookupToolResult {
  findings: {
    id: string;
    resourceId: string;
    ruleCode: string;
    severity: string;
    title: string;
    confidence: number;
  }[];
  total: number;
}

interface RecommendationEngineToolResult {
  recommendations: RecommendationEngineRow[];
  total: number;
}

// Drives one Recommendation Agent run. This is the first agent in the
// DAG whose entire job is *collaboration*: it never queries a scoring or
// evaluation engine of its own — it reads the already-computed Risk
// Agent and Compliance Agent outputs handed to it via
// OrchestrationContext (Phase 20 goal #2/#3 — Agent Handoff / Memory),
// merges them against the existing, persisted Recommendation rows
// (services/analysis/recommendation.service.ts, never regenerated here),
// and produces one prioritized, cross-referenced, confidence-scored list
// (goals #5/#6/#9). If Risk Agent didn't run in this workflow (or ran
// but failed), it falls back to a direct FindingService read so a
// standalone "Discovery -> Recommendation" workflow still produces a
// result; if Compliance didn't run, cross-references are simply omitted
// rather than the run failing (goal #8 — Failure Isolation).
export class RecommendationExecutor implements IRecommendationExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: IRecommendationMemory,
    private readonly telemetry: RecommendationAgentTelemetry,
  ) {}

  async run(
    input: RecommendationExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<RecommendationAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'recommendation.planning', { assetId: input.assetId });

    if (!input.assetId) {
      const error = new MissingRecommendationTargetError();
      this.telemetry.recordRun({
        status: 'FAILED',
        durationMs: Date.now() - startedAtMs,
        recommendationCount: 0,
      });
      throw error;
    }

    const requester: Requester = {
      id: aiContext.user.id,
      role: aiContext.user.role as Requester['role'],
    };
    await getOwnedAsset(input.assetId, requester);
    recordDecision(
      orchestrationContext,
      `assetId=${input.assetId}`,
      'resolved from executor input',
    );

    recordExecutionStep(aiContext, 'recommendation.aggregating', { assetId: input.assetId });

    const warnings: string[] = [];
    const handoffSources: RecommendationHandoffSource[] = [];

    // Step 1: consume the live handoff from OrchestrationContext, if any
    // sibling step already ran in this same workflow execution.
    const { riskFindings: contextRiskFindings, complianceFindings } = resolveHandoffFromContext(
      orchestrationContext,
      input.assetId,
    );
    for (const entry of orchestrationContext.agentOutputs) {
      if (entry.agentId === 'risk-agent' || entry.agentId === 'compliance-agent') {
        this.telemetry.recordHandoff({
          agentId: entry.agentId,
          origin: entry.status === 'SUCCESS' ? 'context' : 'unavailable',
        });
      }
    }

    // Step 2: Risk Agent didn't hand off live output — fall back to a
    // direct FindingService read via the tool layer, so this agent still
    // works standalone (e.g. called directly, or via a
    // "Discovery -> Recommendation" workflow that never runs Risk).
    let riskFindings = contextRiskFindings;
    if (riskFindings === undefined) {
      try {
        const found = await this.callTool<FindingLookupToolResult>(
          'recommendation_finding_lookup',
          { assetId: input.assetId },
          aiContext,
        );
        riskFindings = found.findings.map((f): Finding => ({
          id: f.id,
          title: f.title,
          severity: f.severity as Finding['severity'],
          category: 'RISK',
          description: f.title,
          resourceId: f.resourceId,
          evidence: [],
          confidence: f.confidence,
          agent: 'finding-service',
          timestamp: new Date().toISOString(),
          sourceCode: f.ruleCode,
        }));
      } catch (error) {
        warnings.push(
          `could not fall back to a direct finding lookup: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        riskFindings = [];
      }
    }
    handoffSources.push(handoffSource('risk-agent', contextRiskFindings, true));

    // Compliance has no safe standalone re-derivation path here (it
    // would mean duplicating ComplianceService access this agent doesn't
    // otherwise need) — a missing/failed compliance step just means no
    // compliance cross-references this run, not a failed run.
    handoffSources.push(handoffSource('compliance-agent', complianceFindings, false));

    // Step 3: the existing, persisted Recommendation rows — the
    // authoritative source of *what* to recommend. This agent enriches
    // them; it never invents a new one.
    let engineResult: RecommendationEngineToolResult;
    try {
      engineResult = await this.callTool<RecommendationEngineToolResult>(
        'recommendation_engine_list',
        { assetId: input.assetId },
        aiContext,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'recommendation tool call failed';
      await this.memory.recordFailure({
        assetId: input.assetId,
        message,
        timestamp: new Date().toISOString(),
      });
      return this.finalize({
        status: 'FAILED',
        assetId: input.assetId,
        startedAt,
        startedAtMs,
        recommendations: [],
        handoffSources,
        warnings,
        errors: [message],
      });
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'recommendation.aggregating',
      agentId: 'recommendation-agent',
      status: 'SUCCESS',
      output: engineResult,
    });

    const merged = mergeRecommendations(
      engineResult.recommendations.filter((r) => r.status === 'OPEN'),
      riskFindings ?? [],
      complianceFindings ?? [],
    );

    const status = warnings.length > 0 ? 'PARTIAL' : 'SUCCESS';

    return this.finalize({
      status,
      assetId: input.assetId,
      startedAt,
      startedAtMs,
      recommendations: merged,
      handoffSources,
      warnings,
      errors: [],
    });
  }

  private async callTool<T>(name: string, toolInput: unknown, aiContext: AIContext): Promise<T> {
    const startedAtMs = Date.now();
    try {
      const result = await withRetry(
        () => this.toolRegistry.execute(name, toolInput, aiContext) as Promise<T>,
        {
          retries: TOOL_MAX_ATTEMPTS - 1,
          backoffMs: TOOL_RETRY_BACKOFF_MS,
          isRetryable: isRetryableToolError,
          onRetry: () => this.telemetry.recordRetry(),
        },
      );
      this.telemetry.recordToolCall({
        tool: name,
        success: true,
        durationMs: Date.now() - startedAtMs,
      });
      return result;
    } catch (error) {
      this.telemetry.recordToolCall({
        tool: name,
        success: false,
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  private async finalize(input: {
    status: RecommendationAgentOutput['status'];
    assetId: string;
    startedAt: string;
    startedAtMs: number;
    recommendations: RecommendationView[];
    handoffSources: RecommendationHandoffSource[];
    warnings: string[];
    errors: string[];
  }): Promise<RecommendationAgentOutput> {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - input.startedAtMs;

    const confidenceScore = confidenceFor({
      success: input.status !== 'FAILED',
      count: input.recommendations.length,
      warningCount: input.warnings.length,
    });

    const prioritized = prioritizeRecommendations(input.recommendations);

    const summary = await generateRecommendationSummary({
      assetId: input.assetId,
      recommendations: prioritized,
    });

    await this.memory.recordRun({
      assetId: input.assetId,
      status: input.status,
      recommendationCount: input.recommendations.length,
      startedAt: input.startedAt,
      finishedAt,
      durationMs,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    });

    this.telemetry.recordRun({
      status: input.status,
      durationMs,
      recommendationCount: input.recommendations.length,
    });

    return {
      status: input.status,
      assetId: input.assetId,
      recommendations: input.recommendations,
      prioritized,
      handoffSources: input.handoffSources,
      metadata: { startedAt: input.startedAt, finishedAt, durationMs },
      summary,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    };
  }
}
