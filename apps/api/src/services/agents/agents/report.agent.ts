import type { Agent, AgentPlanHint } from '../agent.interface.js';
import type { AgentContext } from '../agent-context.js';
import { RequestType } from '../dto/execution-plan.js';
import { aiService } from '../../ai/ai.service.js';
import { executiveSummaryPrompt } from '../../ai/prompts/executive-summary.prompt.js';
import { securityReportPrompt } from '../../ai/prompts/security-report.prompt.js';
import { eventService } from '../../assets/event.service.js';
import { AIMode } from '../../ai/dto/ai-report.js';
import type { AIReport, PromptTemplate, StructuredReportSnapshot } from '../../ai/dto/ai-report.js';
import type { Prisma } from '../../../generated/prisma/client.js';

// AI generation is a real network round trip (with AIService's own
// internal retries) — the default 10s task timeout (planner.service.ts)
// is sized for read-only aggregation, not that. plan() only widens it
// when aiMode is actually active, so the OFF-mode default is unaffected.
const AI_REPORT_TIMEOUT_MS = 30_000;

const SECTION_HEADERS: {
  key: keyof Pick<
    AIReport,
    | 'executiveSummary'
    | 'riskNarrative'
    | 'recommendationSummary'
    | 'keyObservations'
    | 'limitations'
  >;
  header: string;
  kind: 'text' | 'list';
}[] = [
  { key: 'executiveSummary', header: '## Executive Summary', kind: 'text' },
  { key: 'riskNarrative', header: '## Risk Narrative', kind: 'text' },
  { key: 'recommendationSummary', header: '## Recommendation Summary', kind: 'text' },
  { key: 'keyObservations', header: '## Key Observations', kind: 'list' },
  { key: 'limitations', header: '## Limitations', kind: 'list' },
];

// Turns AIService's raw narrative text back into structured fields by
// splitting on the fixed headings every prompt template is instructed to
// use. If a template only ever produces one section (e.g. SUMMARY mode),
// no headings are found and the whole response becomes the executive
// summary instead.
function parseNarrative(text: string): Partial<AIReport> {
  const found = SECTION_HEADERS.map((section) => ({
    ...section,
    index: text.indexOf(section.header),
  })).filter((section) => section.index !== -1);

  if (found.length === 0) {
    return { executiveSummary: text.trim() };
  }

  found.sort((a, b) => a.index - b.index);

  const result: Partial<AIReport> = {};
  for (let i = 0; i < found.length; i += 1) {
    const section = found[i];
    const start = section.index + section.header.length;
    const end = i + 1 < found.length ? found[i + 1].index : text.length;
    const raw = text.slice(start, end).trim();

    if (section.kind === 'text') {
      (result[section.key] as string | undefined) = raw;
    } else {
      (result[section.key] as string[] | undefined) = raw
        .split('\n')
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter((line) => line.length > 0);
    }
  }
  return result;
}

// Has no service of its own — pure aggregation over the other four
// agents' already-computed outputs, read back off AgentContext (never
// re-queried). If an upstream task failed or was skipped, its section is
// simply omitted rather than the whole report failing — a partial report
// is more useful than no report. Phase 7D adds an optional AI-generated
// narrative on top of that same structured output, gated by
// AgentContext.aiMode; it never bypasses AIService/PromptBuilder and
// never calls a provider directly.
class ReportAgent implements Agent {
  id(): string {
    return 'report';
  }

  supports(requestType: string): boolean {
    return requestType === RequestType.SECURITY_REPORT;
  }

  plan(context: AgentContext): AgentPlanHint {
    return {
      dependsOn: ['discovery', 'risk', 'compliance', 'recommendation'],
      timeoutMs: context.aiMode !== AIMode.OFF ? AI_REPORT_TIMEOUT_MS : undefined,
    };
  }

  async execute(context: AgentContext): Promise<Record<string, unknown>> {
    const discovery = context.getResult('discovery');
    const risk = context.getResult('risk');
    const compliance = context.getResult('compliance');
    const recommendation = context.getResult('recommendation');

    const riskData = risk?.status === 'SUCCESS' ? risk.data : undefined;
    const complianceData = compliance?.status === 'SUCCESS' ? compliance.data : undefined;
    const recommendationData =
      recommendation?.status === 'SUCCESS' ? recommendation.data : undefined;
    const discoveryData = discovery?.status === 'SUCCESS' ? discovery.data : undefined;

    const structured: StructuredReportSnapshot = {
      executive: {
        overallRiskScore: riskData?.overallScore ?? null,
        complianceScore: complianceData?.complianceScore ?? null,
        openFindingsCount: riskData?.openFindingsCount ?? null,
        topRecommendations:
          (recommendationData?.prioritized as unknown[] | undefined)?.slice(0, 3) ?? [],
      },
      technical: {
        risk: riskData ?? null,
        compliance: complianceData ?? null,
        recommendations: recommendationData ?? null,
      },
      asset: {
        assetId: context.assetId,
        discovery: discoveryData ?? null,
      },
    };

    if (context.aiMode === AIMode.OFF) {
      return { ...structured };
    }

    return { ...structured, aiReport: await this.buildAIReport(context, structured) };
  }

  private async buildAIReport(
    context: AgentContext,
    structured: StructuredReportSnapshot,
  ): Promise<AIReport> {
    const template: PromptTemplate =
      context.aiMode === AIMode.SUMMARY ? executiveSummaryPrompt : securityReportPrompt;

    await this.emitEvent(context, 'AI_REPORT_STARTED', { mode: context.aiMode });

    try {
      const response = await aiService.generate({
        requester: context.requester,
        assetId: context.assetId,
        systemPrompt: template.systemPrompt,
        prompt: template.buildUserPrompt(structured),
        focus: 'SECURITY_REPORT_AI',
      });

      const aiReport: AIReport = {
        aiStatus: 'SUCCESS',
        mode: context.aiMode,
        ...parseNarrative(response.text),
        metadata: {
          provider: response.provider,
          model: response.model,
          latencyMs: response.latencyMs,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          totalTokens: response.usage.totalTokens,
          estimatedCostUsd: response.estimatedCostUsd,
          generatedAt: new Date().toISOString(),
        },
      };

      await this.emitEvent(context, 'AI_REPORT_COMPLETED', {
        mode: context.aiMode,
        provider: response.provider,
        model: response.model,
      });
      return aiReport;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.emitEvent(context, 'AI_REPORT_FAILED', { mode: context.aiMode, error: message });
      return { aiStatus: 'FAILED', mode: context.aiMode, error: message };
    }
  }

  private async emitEvent(
    context: AgentContext,
    type: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await eventService.createForAsset(context.assetId, context.requester, {
        type,
        severity: type === 'AI_REPORT_FAILED' ? 'WARNING' : 'INFO',
        title: type,
        metadata: metadata as Prisma.InputJsonValue,
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const reportAgent = new ReportAgent();
