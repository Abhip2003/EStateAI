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
import { MissingRiskTargetError } from './risk.errors.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { businessImpactFromCounts } from './risk.scoring.js';
import { generateRiskSummary, explainTopFindings } from './risk.summary.js';
import { buildFindingView, groupBySeverity, type RiskEngineFinding } from './risk.finding.js';
import type {
  IRiskExecutor,
  RiskExecutorInput,
  RiskAgentOutput,
  IRiskMemory,
} from './risk.interface.js';
import type { RiskAgentTelemetry } from './risk.telemetry.js';
import type { RiskFindingView, RiskSeverityCounts } from './risk.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

// Structural failures (bad input, ownership denial) will never succeed on
// retry — only genuinely transient-looking failures are worth another
// attempt. Mirrors discovery.executor.ts's isRetryableToolError.
function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return (
    !message.includes('not found') &&
    !message.includes('do not have access') &&
    !message.includes('not yet supported')
  );
}

function confidenceFor(input: {
  success: boolean;
  findingCount: number;
  warningCount: number;
  errorCount: number;
}): number {
  if (!input.success) {
    return input.findingCount > 0 ? 0.4 : 0;
  }
  if (input.errorCount > 0) return 0.5;
  if (input.warningCount > 0) return 0.75;
  return 1;
}

// Drives one Risk Agent run: resolves the target asset, calls the risk
// score + finding tools (risk.tool.ts — thin wrappers over the existing
// RiskService/FindingService), shapes results into RiskFindingView via
// risk.finding.ts (severity/confidence copied verbatim, never
// recalculated), optionally enriches the top findings and generates a
// narrative summary via the LLM (risk.summary.ts, graceful fallback),
// and records the outcome into RiskMemory and telemetry. This class never
// performs discovery, compliance evaluation, recommendations, or
// reporting — only risk analysis over data another agent already
// discovered.
export class RiskExecutor implements IRiskExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: IRiskMemory,
    private readonly telemetry: RiskAgentTelemetry,
  ) {}

  async run(
    input: RiskExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<RiskAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'risk.planning', { assetId: input.assetId });

    if (!input.assetId) {
      const error = new MissingRiskTargetError();
      this.telemetry.recordRun({
        status: 'FAILED',
        durationMs: Date.now() - startedAtMs,
        counts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
      });
      // Thrown, not folded into a graceful result — a structural problem
      // resolved before anything is attempted. job-executor.ts recognizes
      // this as permanent (see its isPermanentFailure()), so the
      // enclosing AI_RISK job goes straight to FAILED instead of retrying
      // an input that will never become valid on its own.
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

    recordExecutionStep(aiContext, 'risk.scoring', { assetId: input.assetId });

    let overallScore: number;
    let counts: RiskSeverityCounts;
    let rawFindings: RiskEngineFinding[];
    const warnings: string[] = [];

    try {
      const scoreResult = await this.callTool<{ overallScore: number; counts: RiskSeverityCounts }>(
        'risk_engine_score',
        { assetId: input.assetId },
        aiContext,
      );
      overallScore = scoreResult.overallScore;
      counts = scoreResult.counts;

      const findingResult = await this.callTool<{ findings: RiskEngineFinding[]; total: number }>(
        'risk_finding_store_list',
        { assetId: input.assetId },
        aiContext,
      );
      rawFindings = findingResult.findings;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'risk tool call failed';
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
        overallScore: 0,
        counts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
        findings: [],
        warnings: [],
        errors: [message],
      });
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'risk.scoring',
      agentId: 'risk-agent',
      status: 'SUCCESS',
      output: { overallScore, counts, findingCount: rawFindings.length },
    });

    const seenRuleCodes = new Set(await this.memory.getSeenRuleCodes(input.assetId));
    let findings: RiskFindingView[] = rawFindings.map((finding) =>
      buildFindingView(finding, seenRuleCodes),
    );

    // Sort by severity so "top findings" (explained by the LLM below) are
    // the ones that matter most — priority ordering the spec asks for.
    const severityRank: Record<string, number> = {
      CRITICAL: 5,
      HIGH: 4,
      MEDIUM: 3,
      LOW: 2,
      INFORMATIONAL: 1,
    };
    findings = findings.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);

    try {
      const llmStartedAt = Date.now();
      findings = await explainTopFindings(findings);
      this.telemetry.recordLLMCall({ durationMs: Date.now() - llmStartedAt });
    } catch (error) {
      // Enrichment is best-effort narration, not core analysis — its
      // failure degrades gracefully into a warning rather than failing
      // the whole run, since the deterministic reasoning above already
      // populated every finding.
      warnings.push(
        `finding explanation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await this.memory.rememberSeenRuleCodes(
      input.assetId,
      findings.map((f) => f.ruleCode),
    );
    await this.memory.recordScoreSnapshot(input.assetId, {
      overallScore,
      counts,
      timestamp: new Date().toISOString(),
    });

    const status = warnings.length > 0 ? 'PARTIAL' : 'SUCCESS';

    return this.finalize({
      status,
      assetId: input.assetId,
      startedAt,
      startedAtMs,
      overallScore,
      counts,
      findings,
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
    status: RiskAgentOutput['status'];
    assetId: string;
    startedAt: string;
    startedAtMs: number;
    overallScore: number;
    counts: RiskSeverityCounts;
    findings: RiskFindingView[];
    warnings: string[];
    errors: string[];
  }): Promise<RiskAgentOutput> {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - input.startedAtMs;
    const businessImpact = businessImpactFromCounts(input.counts);

    const confidenceScore = confidenceFor({
      success: input.status !== 'FAILED',
      findingCount: input.findings.length,
      warningCount: input.warnings.length,
      errorCount: input.errors.length,
    });

    const llmStartedAt = Date.now();
    const summary = await generateRiskSummary({
      assetId: input.assetId,
      overallScore: input.overallScore,
      businessImpact,
      counts: input.counts,
      findingCount: input.findings.length,
    });
    this.telemetry.recordLLMCall({ durationMs: Date.now() - llmStartedAt });

    await this.memory.recordRun({
      assetId: input.assetId,
      status: input.status,
      overallScore: input.overallScore,
      counts: input.counts,
      findingCount: input.findings.length,
      startedAt: input.startedAt,
      finishedAt,
      durationMs,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    });

    this.telemetry.recordRun({ status: input.status, durationMs, counts: input.counts });

    const grouped = groupBySeverity(input.findings);

    return {
      status: input.status,
      assetId: input.assetId,
      overallScore: input.overallScore,
      businessImpact,
      counts: input.counts,
      findings: input.findings,
      criticalFindings: grouped.critical,
      highFindings: grouped.high,
      mediumFindings: grouped.medium,
      lowFindings: grouped.low,
      metadata: { startedAt: input.startedAt, finishedAt, durationMs },
      summary,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    };
  }
}
