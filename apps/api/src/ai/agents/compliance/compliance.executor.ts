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
import { MissingComplianceTargetError } from './compliance.errors.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { generateComplianceSummary, explainTopGaps } from './compliance.summary.js';
import { ALL_FRAMEWORKS } from './compliance.mapping.js';
import type {
  IComplianceExecutor,
  ComplianceExecutorInput,
  ComplianceAgentOutput,
  IComplianceMemory,
} from './compliance.interface.js';
import type { ComplianceAgentTelemetry } from './compliance.telemetry.js';
import type {
  ComplianceFrameworkResult,
  ComplianceControlView,
  PolicyOutcomeView,
} from './compliance.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

// Structural failures (bad input, ownership denial) will never succeed on
// retry — only genuinely transient-looking failures are worth another
// attempt. Mirrors risk.executor.ts's isRetryableToolError.
function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return !message.includes('not found') && !message.includes('do not have access');
}

function confidenceFor(input: {
  success: boolean;
  frameworkCount: number;
  warningCount: number;
  errorCount: number;
}): number {
  if (!input.success) {
    return input.frameworkCount > 0 ? 0.4 : 0;
  }
  if (input.errorCount > 0) return 0.5;
  if (input.warningCount > 0) return 0.75;
  return 1;
}

interface ComplianceReportToolResult {
  complianceScore: number;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  policyFailures: PolicyOutcomeView[];
  policyPasses: PolicyOutcomeView[];
}

// Drives one Compliance Agent run: resolves the target asset, calls the
// compliance report tool (compliance.tool.ts — a thin wrapper over the
// existing ComplianceService/PolicyService), then for every registered
// framework (compliance.mapping.ts's ALL_FRAMEWORKS — adding a fifth
// framework there is the only change needed to evaluate it here too)
// calls the control-coverage tool to build passed/failed/missing control
// views, optionally enriches the top gaps and generates a narrative
// summary via the LLM (compliance.summary.ts, graceful fallback), and
// records the outcome into ComplianceMemory and telemetry. This class
// never performs discovery, risk scoring, recommendations, or
// reporting — only compliance evaluation over data Discovery/Risk
// Agents already produced.
export class ComplianceExecutor implements IComplianceExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: IComplianceMemory,
    private readonly telemetry: ComplianceAgentTelemetry,
  ) {}

  async run(
    input: ComplianceExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<ComplianceAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'compliance.planning', { assetId: input.assetId });

    if (!input.assetId) {
      const error = new MissingComplianceTargetError();
      this.telemetry.recordRun({
        status: 'FAILED',
        durationMs: Date.now() - startedAtMs,
        frameworks: [],
      });
      // Thrown, not folded into a graceful result — a structural problem
      // resolved before anything is attempted. job-executor.ts recognizes
      // this as permanent (see its isPermanentFailure()), so the
      // enclosing AI_COMPLIANCE job goes straight to FAILED instead of
      // retrying an input that will never become valid on its own.
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

    recordExecutionStep(aiContext, 'compliance.evaluating', { assetId: input.assetId });

    let report: ComplianceReportToolResult;
    try {
      report = await this.callTool<ComplianceReportToolResult>(
        'compliance_engine_evaluate',
        { assetId: input.assetId },
        aiContext,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'compliance tool call failed';
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
        complianceScore: 0,
        passCount: 0,
        failCount: 0,
        warningCount: 0,
        notApplicableCount: 0,
        policyFailures: [],
        policyPasses: [],
        frameworks: [],
        warnings: [],
        errors: [message],
      });
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'compliance.evaluating',
      agentId: 'compliance-agent',
      status: 'SUCCESS',
      output: report,
    });

    const warnings: string[] = [];
    const frameworks: ComplianceFrameworkResult[] = [];

    for (const framework of ALL_FRAMEWORKS) {
      try {
        const coverage = await this.callTool<{
          framework: string;
          name: string;
          passedControls: ComplianceControlView[];
          failedControls: ComplianceControlView[];
          missingControls: ComplianceControlView[];
          coveragePercent: number;
        }>('compliance_control_coverage', { assetId: input.assetId, framework }, aiContext);

        const allControls = [
          ...coverage.passedControls,
          ...coverage.failedControls,
          ...coverage.missingControls,
        ];
        const explained = await explainTopGaps(allControls);
        const explainedById = new Map(
          explained.map((c) => [`${c.framework}:${c.controlId}:${c.resourceId ?? ''}`, c]),
        );
        const rehydrate = (c: ComplianceControlView) =>
          explainedById.get(`${c.framework}:${c.controlId}:${c.resourceId ?? ''}`) ?? c;

        frameworks.push({
          framework: coverage.framework as ComplianceFrameworkResult['framework'],
          name: coverage.name,
          passedControls: coverage.passedControls.map(rehydrate),
          failedControls: coverage.failedControls.map(rehydrate),
          missingControls: coverage.missingControls.map(rehydrate),
          coveragePercent: coverage.coveragePercent,
        });
      } catch (error) {
        // One framework's coverage computation failing degrades to a
        // warning, not a failed run — the core compliance report above
        // already succeeded and is the authoritative score.
        warnings.push(
          `${framework} coverage computation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    await this.memory.rememberSeenViolations(
      input.assetId,
      report.policyFailures.map((f) => f.policyCode),
    );
    await this.memory.recordScoreSnapshot(input.assetId, {
      complianceScore: report.complianceScore,
      passCount: report.passCount,
      failCount: report.failCount,
      timestamp: new Date().toISOString(),
    });

    const status = warnings.length > 0 ? 'PARTIAL' : 'SUCCESS';

    return this.finalize({
      status,
      assetId: input.assetId,
      startedAt,
      startedAtMs,
      complianceScore: report.complianceScore,
      passCount: report.passCount,
      failCount: report.failCount,
      warningCount: report.warningCount,
      notApplicableCount: report.notApplicableCount,
      policyFailures: report.policyFailures,
      policyPasses: report.policyPasses,
      frameworks,
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
    status: ComplianceAgentOutput['status'];
    assetId: string;
    startedAt: string;
    startedAtMs: number;
    complianceScore: number;
    passCount: number;
    failCount: number;
    warningCount: number;
    notApplicableCount: number;
    policyFailures: PolicyOutcomeView[];
    policyPasses: PolicyOutcomeView[];
    frameworks: ComplianceFrameworkResult[];
    warnings: string[];
    errors: string[];
  }): Promise<ComplianceAgentOutput> {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - input.startedAtMs;

    const confidenceScore = confidenceFor({
      success: input.status !== 'FAILED',
      frameworkCount: input.frameworks.length,
      warningCount: input.warnings.length,
      errorCount: input.errors.length,
    });

    const summary = await generateComplianceSummary({
      assetId: input.assetId,
      complianceScore: input.complianceScore,
      passCount: input.passCount,
      failCount: input.failCount,
      warningCount: input.warningCount,
      frameworkCount: input.frameworks.length,
    });

    await this.memory.recordRun({
      assetId: input.assetId,
      status: input.status,
      complianceScore: input.complianceScore,
      passCount: input.passCount,
      failCount: input.failCount,
      warningCount: input.warningCount,
      notApplicableCount: input.notApplicableCount,
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
      frameworks: input.frameworks.map((f) => ({
        framework: f.framework,
        passed: f.passedControls.length,
        failed: f.failedControls.length,
        missing: f.missingControls.length,
      })),
    });

    return {
      status: input.status,
      assetId: input.assetId,
      complianceScore: input.complianceScore,
      passCount: input.passCount,
      failCount: input.failCount,
      warningCount: input.warningCount,
      notApplicableCount: input.notApplicableCount,
      policyFailures: input.policyFailures,
      policyPasses: input.policyPasses,
      frameworks: input.frameworks,
      metadata: { startedAt: input.startedAt, finishedAt, durationMs },
      summary,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    };
  }
}
