import type { AIContext } from '../../types/context.types.js';
import { recordExecutionStep } from '../../context/ai-context-builder.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { withRetry } from '../../utils/retry.js';
import { ToolExecutionError } from '../../errors/index.js';
import {
  type OrchestrationContext,
  type AgentOutputEntry,
  recordAgentOutput,
  recordDecision,
} from '../../orchestrator/execution.context.js';
import { MissingReportTargetError } from './report.errors.js';
import { generateReportSummary } from './report.summary.js';
import type {
  IReportExecutor,
  ReportExecutorInput,
  ReportAgentOutput,
  IReportMemory,
} from './report.interface.js';
import type { ReportAgentTelemetry } from './report.telemetry.js';
import type { ReportSection, ReportSourceAgentId, ReportExecutiveSummary } from './report.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return !message.includes('not found') && !message.includes('do not have access');
}

const SOURCE_TITLES: Record<ReportSourceAgentId, string> = {
  'discovery-agent': 'Discovery',
  'risk-agent': 'Risk Analysis',
  'compliance-agent': 'Compliance Analysis',
  'recommendation-agent': 'Recommendations',
};

// Memory-backed agents (keyed by assetId) that this agent can fall back
// to reading directly when they didn't run live in this workflow —
// Discovery Agent's memory is keyed by accountId, not assetId, so it has
// no equivalent standalone fallback here and can only ever come from a
// live handoff.
const MEMORY_FALLBACK_AGENTS = new Set<ReportSourceAgentId>([
  'risk-agent',
  'compliance-agent',
  'recommendation-agent',
]);

interface SummaryRecordLike {
  status: string;
  confidenceScore: number;
  finishedAt: string;
}

async function readMemoryFallback(
  agentId: ReportSourceAgentId,
  assetId: string,
): Promise<{ record: SummaryRecordLike; content: string } | undefined> {
  try {
    if (agentId === 'risk-agent') {
      const { riskMemory } = await import('../risk/index.js');
      const record = await riskMemory.getLastRun(assetId);
      if (!record) return undefined;
      return {
        record,
        content: `Last known overall risk score: ${record.overallScore} (${record.findingCount} open finding(s), recorded at ${record.finishedAt}). Not part of this workflow run.`,
      };
    }
    if (agentId === 'compliance-agent') {
      const { complianceMemory } = await import('../compliance/index.js');
      const record = await complianceMemory.getLastRun(assetId);
      if (!record) return undefined;
      return {
        record,
        content: `Last known compliance score: ${record.complianceScore} (${record.failCount} failed check(s), recorded at ${record.finishedAt}). Not part of this workflow run.`,
      };
    }
    if (agentId === 'recommendation-agent') {
      const { recommendationMemory } = await import('../recommendation/index.js');
      const record = await recommendationMemory.getLastRun(assetId);
      if (!record) return undefined;
      return {
        record,
        content: `Last known recommendation count: ${record.recommendationCount} (recorded at ${record.finishedAt}). Not part of this workflow run.`,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function latestEntryFor(
  context: OrchestrationContext,
  agentId: ReportSourceAgentId,
): AgentOutputEntry | undefined {
  return [...context.agentOutputs].reverse().find((e) => e.agentId === agentId);
}

function summaryFrom(output: unknown): string | undefined {
  if (output && typeof output === 'object' && 'summary' in output) {
    const value = output.summary;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

// Drives one Report Agent run — the terminal step of the collaboration
// DAG. Has no evaluation logic of its own: for each of the four upstream
// agents it (1) reads the live handoff off OrchestrationContext if that
// step ran in this same workflow execution, (2) falls back to that
// agent's own memory (its last recorded run) for a standalone report
// call, or (3) marks the section MISSING — never failing the whole run
// over one missing/failed upstream agent (Phase 20 goal #8, mirroring
// the existing services/agents/agents/report.agent.ts precedent: "a
// partial report is more useful than no report").
export class ReportExecutor implements IReportExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: IReportMemory,
    private readonly telemetry: ReportAgentTelemetry,
  ) {}

  async run(
    input: ReportExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<ReportAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'report.planning', { assetId: input.assetId });

    if (!input.assetId) {
      const error = new MissingReportTargetError();
      this.telemetry.recordRun({
        status: 'FAILED',
        durationMs: Date.now() - startedAtMs,
        sections: [],
      });
      throw error;
    }

    try {
      await this.callTool('report_asset_lookup', { assetId: input.assetId }, aiContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'report tool call failed';
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
        sections: [],
        warnings: [],
        errors: [message],
      });
    }

    recordDecision(
      orchestrationContext,
      `assetId=${input.assetId}`,
      'resolved from executor input',
    );
    recordExecutionStep(aiContext, 'report.aggregating', { assetId: input.assetId });

    const warnings: string[] = [];
    const sections: ReportSection[] = [];
    const executive: ReportExecutiveSummary = {
      overallRiskScore: null,
      complianceScore: null,
      openFindingsCount: null,
      recommendationCount: null,
      topRecommendations: [],
    };

    for (const agentId of Object.keys(SOURCE_TITLES) as ReportSourceAgentId[]) {
      const entry = latestEntryFor(orchestrationContext, agentId);
      const title = SOURCE_TITLES[agentId];

      if (entry?.status === 'SUCCESS') {
        this.applyToExecutive(executive, agentId, entry.output);
        sections.push({
          id: agentId,
          title,
          status: 'INCLUDED',
          origin: 'context',
          content:
            summaryFrom(entry.output) ?? `${title} completed with no narrative summary available.`,
          confidence: entry.confidence,
        });
        continue;
      }

      if (entry?.status === 'FAILED') {
        warnings.push(`${title} step failed during this workflow run.`);
        sections.push({
          id: agentId,
          title,
          status: 'FAILED',
          origin: 'context',
          content: `${title} failed during this workflow run — its data is not reflected in this report.`,
        });
        continue;
      }

      if (MEMORY_FALLBACK_AGENTS.has(agentId)) {
        const fallback = await readMemoryFallback(agentId, input.assetId);
        if (fallback) {
          this.applyRecordToExecutive(executive, agentId, fallback.record);
          sections.push({
            id: agentId,
            title,
            status: 'INCLUDED',
            origin: 'memory',
            content: fallback.content,
            confidence: fallback.record.confidenceScore * 100,
          });
          continue;
        }
      }

      warnings.push(`${title} data was not available for this report.`);
      sections.push({
        id: agentId,
        title,
        status: 'MISSING',
        origin: 'unavailable',
        content: `No ${title.toLowerCase()} data available for this asset yet.`,
      });
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'report.aggregating',
      agentId: 'report-agent',
      status: 'SUCCESS',
      output: { sectionCount: sections.length },
    });

    const includedCount = sections.filter((s) => s.status === 'INCLUDED').length;
    const status =
      includedCount === 0 ? 'FAILED' : includedCount < sections.length ? 'PARTIAL' : 'SUCCESS';

    return this.finalize({
      status,
      assetId: input.assetId,
      startedAt,
      startedAtMs,
      sections,
      executive,
      warnings,
      errors: [],
    });
  }

  // Reads whichever fields exist on a live agent output (Discovery/Risk/
  // Compliance/Recommendation each have their own distinct shape — see
  // their *.interface.ts) without importing any of those types here,
  // same "duck-typed read" approach executor.ts's readConfidence() uses.
  // Never recomputes a score — every value is copied straight off the
  // upstream agent's own already-computed output.
  private applyToExecutive(
    executive: ReportExecutiveSummary,
    agentId: ReportSourceAgentId,
    output: unknown,
  ): void {
    if (!output || typeof output !== 'object') return;
    const record = output as Record<string, unknown>;

    if (agentId === 'risk-agent') {
      if (typeof record.overallScore === 'number') executive.overallRiskScore = record.overallScore;
      if (Array.isArray(record.findings)) executive.openFindingsCount = record.findings.length;
    }
    if (agentId === 'compliance-agent') {
      if (typeof record.complianceScore === 'number')
        executive.complianceScore = record.complianceScore;
    }
    if (agentId === 'recommendation-agent' && Array.isArray(record.prioritized)) {
      executive.recommendationCount = record.prioritized.length;
      executive.topRecommendations = (record.prioritized as unknown[])
        .slice(0, 3)
        .filter(
          (r): r is { title: string; priority: string } =>
            !!r && typeof r === 'object' && 'title' in r && 'priority' in r,
        )
        .map((r) => ({ title: r.title, priority: r.priority }));
    }
  }

  // Same idea as applyToExecutive, but reading the coarser memory-fallback
  // record shape (RiskSummaryRecord/ComplianceSummaryRecord/
  // RecommendationSummaryRecord) instead of a live agent output — those
  // records don't carry the raw findings/prioritized arrays, only counts,
  // so topRecommendations stays empty on the fallback path.
  private applyRecordToExecutive(
    executive: ReportExecutiveSummary,
    agentId: ReportSourceAgentId,
    record: SummaryRecordLike,
  ): void {
    if (agentId === 'risk-agent' && 'overallScore' in record) {
      const r = record as SummaryRecordLike & { overallScore: number; findingCount: number };
      executive.overallRiskScore = r.overallScore;
      executive.openFindingsCount = r.findingCount;
    }
    if (agentId === 'compliance-agent' && 'complianceScore' in record) {
      executive.complianceScore = (
        record as SummaryRecordLike & { complianceScore: number }
      ).complianceScore;
    }
    if (agentId === 'recommendation-agent' && 'recommendationCount' in record) {
      executive.recommendationCount = (
        record as SummaryRecordLike & { recommendationCount: number }
      ).recommendationCount;
    }
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
    status: ReportAgentOutput['status'];
    assetId: string;
    startedAt: string;
    startedAtMs: number;
    sections: ReportSection[];
    executive?: ReportExecutiveSummary;
    warnings: string[];
    errors: string[];
  }): Promise<ReportAgentOutput> {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - input.startedAtMs;

    const included = input.sections.filter((s) => s.status === 'INCLUDED');
    const confidenceScore =
      input.status === 'FAILED'
        ? 0
        : included.length === 0
          ? 0
          : Math.min(
              1,
              included.reduce((sum, s) => sum + (s.confidence ?? 70), 0) / included.length / 100,
            );

    const summary = await generateReportSummary({
      assetId: input.assetId,
      sections: input.sections,
    });

    await this.memory.recordRun({
      assetId: input.assetId,
      status: input.status,
      sectionCount: input.sections.length,
      includedSectionCount: included.length,
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
      sections: input.sections.map((s) => ({ sourceAgent: s.id, status: s.status })),
    });

    return {
      status: input.status,
      assetId: input.assetId,
      summary,
      sections: input.sections,
      executive: input.executive ?? {
        overallRiskScore: null,
        complianceScore: null,
        openFindingsCount: null,
        recommendationCount: null,
        topRecommendations: [],
      },
      metadata: { startedAt: input.startedAt, finishedAt, durationMs },
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    };
  }
}
