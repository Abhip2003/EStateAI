import type { AIContext } from '../../types/context.types.js';
import { recordExecutionStep } from '../../context/ai-context-builder.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { ToolExecutor } from '../../tools/tool-executor.js';
import { withRetry } from '../../utils/retry.js';
import { ToolExecutionError } from '../../errors/index.js';
import {
  type OrchestrationContext,
  recordAgentOutput,
  recordDecision,
} from '../../orchestrator/execution.context.js';
import { orchestratorFoundation } from '../../orchestrator/orchestrator.js';
import { accountRepository } from '../../../repositories/account.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { AssetNotFoundError } from '../../../services/assets/errors.js';
import { ForbiddenError } from '../../../services/auth/errors.js';
import { MissingConversationIdError } from './copilot.errors.js';
import { generateAnswer } from './copilot.summary.js';
import { classifyIntent, extractRecommendationIndex } from './copilot.intent.js';
import { selectTool, type ToolSelection } from './copilot.tool-selector.js';
import type {
  ICopilotExecutor,
  CopilotExecutorInput,
  CopilotAgentOutput,
  ICopilotMemory,
} from './copilot.interface.js';
import type { CopilotAgentTelemetry } from './copilot.telemetry.js';
import type {
  CopilotExplanation,
  CopilotIntent,
  CopilotTriggeredWorkflow,
} from './copilot.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return !message.includes('not found') && !message.includes('do not have access');
}

// Which workflow Intelligent Routing runs for each intent when the data
// it needs doesn't exist yet — ANALYZE always runs one (an explicit
// "(re)analyze" request), per the spec's own "Analyze this asset -> Run
// Discovery -> Run Risk -> Return explanation" example; the others only
// run one when their own lookup comes back empty (see run()).
const ROUTING_WORKFLOW: Partial<Record<CopilotIntent, string>> = {
  ANALYZE: 'risk-only',
  EXPLAIN_RISK: 'risk-only',
  EXPLAIN_COMPLIANCE: 'compliance-only',
  EXPLAIN_RECOMMENDATION: 'risk-recommendation',
  SUMMARIZE_REPORT: 'full-security-analysis',
};

interface RiskLookupResult {
  overallScore: number;
  counts: { critical: number; high: number; medium: number; low: number; informational: number };
  topFindings: { id: string; title: string; severity: string; resourceId: string }[];
}
interface ComplianceLookupResult {
  complianceScore: number;
  passCount: number;
  failCount: number;
  policyFailures: { policyCode: string; policyName: string; resourceId: string; reason: string }[];
}
interface RecommendationLookupResult {
  recommendations: {
    id: string;
    title: string;
    description: string;
    estimatedImpact: string;
    priority: string;
  }[];
  total: number;
}
interface AssetLookupResult {
  assetId: string;
  resourceCount: number;
}

const NO_ASSET_EXPLANATION: CopilotExplanation = {
  summary: 'No asset is in scope for this conversation yet.',
  reasoning:
    'Ask about a specific asset, or provide an assetId, and I can explain its risk, compliance, or recommendations.',
  evidence: [],
  suggestedAction: 'Specify which asset you want to discuss.',
  confidence: 50,
};

// Drives one Copilot Agent turn. The primary conversational interface
// for EstateAI (Phase 22): classifies the message into a CopilotIntent
// (copilot.intent.ts), resolves conversation state (last asset/intent/
// recommendation, for follow-ups), gathers grounding data from existing
// agents' services via its own tools, auto-triggers a workflow through
// the existing orchestratorFoundation.service when that data doesn't
// exist yet (Intelligent Routing), builds a deterministic Explanation
// (summary/reasoning/evidence/suggestedAction/confidence), and narrates
// it in prose via the LLM (graceful fallback). Never calls another
// agent directly — routing always goes through the same
// OrchestratorService/WorkflowEngine every other multi-step run uses.
export class CopilotExecutor implements ICopilotExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: ICopilotMemory,
    private readonly telemetry: CopilotAgentTelemetry,
    private readonly toolExecutor: ToolExecutor,
  ) {}

  async run(
    input: CopilotExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<CopilotAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'copilot.planning', { conversationId: input.conversationId });

    if (!input.conversationId) {
      const error = new MissingConversationIdError();
      this.telemetry.recordRun({
        status: 'FAILED',
        intent: 'GENERAL',
        durationMs: Date.now() - startedAtMs,
      });
      throw error;
    }

    const warnings: string[] = [];
    const sourceAgents: string[] = [];
    const session = await this.memory.getSessionState(input.conversationId);

    await this.memory.appendTurn(input.conversationId, 'user', input.message);

    let intent = classifyIntent(input.message);
    if (intent === 'FOLLOW_UP') {
      intent = session?.lastIntent ?? 'GENERAL';
    }

    const assetId = input.assetId ?? session?.lastAssetId ?? orchestrationContext.assets[0]?.id;
    recordDecision(orchestrationContext, `intent=${intent}`, `assetId=${assetId ?? 'none'}`);
    recordExecutionStep(aiContext, 'copilot.gathering', { intent, assetId });

    let explanation: CopilotExplanation;
    let triggeredWorkflow: CopilotTriggeredWorkflow | undefined;
    let recommendationId: string | undefined = session?.lastRecommendationId;
    const citationIds: string[] = [];

    if (!assetId) {
      explanation = NO_ASSET_EXPLANATION;
    } else {
      try {
        const assetInfo = await this.callTool<AssetLookupResult>(
          'copilot_asset_lookup',
          { assetId },
          aiContext,
        );
        sourceAgents.push('copilot-agent');

        // Automatic tool selection (Phase 24 spec #8) — a message that
        // matches a tool-trigger pattern ("list open github issues",
        // "search previous findings", "count findings") is answered
        // directly from that tool's live result, bypassing the
        // intent-based explanation flow below entirely. Runs through
        // ToolExecutor (permission + agent-allowlist enforcement,
        // telemetry, ToolExecutionTrace), not ToolRegistry directly.
        const toolSelection = selectTool(input.message);

        if (toolSelection) {
          const selected = await this.runSelectedTool(
            toolSelection,
            assetId,
            aiContext,
            orchestrationContext,
          );
          explanation = selected.explanation;
          sourceAgents.push(...selected.sourceAgents);
        } else {
          const needsRouting = assetInfo.resourceCount === 0 || intent === 'ANALYZE';
          const routingWorkflowId = ROUTING_WORKFLOW[intent];
          if (needsRouting && routingWorkflowId) {
            triggeredWorkflow = await this.tryTriggerWorkflow(
              routingWorkflowId,
              assetId,
              orchestrationContext,
            );
            if (!triggeredWorkflow) {
              warnings.push(
                `could not auto-run "${routingWorkflowId}" (no connected account for this asset) — answering with whatever data already exists`,
              );
            }
          }

          const gathered = await this.gatherExplanation(intent, assetId, input.message, aiContext);
          explanation = gathered.explanation;
          sourceAgents.push(...gathered.sourceAgents);
          recommendationId = gathered.recommendationId ?? recommendationId;
        }

        // RAG grounding (Phase 23 spec #6) — search the Knowledge Store
        // for this already-ownership-verified asset (assetId only ever
        // reaches here after copilot_asset_lookup succeeded), and fold
        // any retrieved document text into the explanation's evidence so
        // generateAnswer's "grounded only in the above" prompt can draw
        // on it. Scoped to `assetId` deliberately — an unscoped search
        // would let one user's question surface another user's indexed
        // findings. Best-effort: a retrieval failure degrades to
        // whatever gatherExplanation already produced, never the whole
        // answer.
        const grounding = await this.retrieveGrounding(
          input.message,
          assetId,
          input.conversationId,
          aiContext,
        );
        if (grounding.length > 0) {
          citationIds.push(...grounding.map((doc) => doc.id));
          explanation = {
            ...explanation,
            evidence: [...explanation.evidence, ...grounding.map((doc) => doc.text)],
          };
        }
      } catch (error) {
        // Ownership errors are structural, not conversational — never
        // absorbed into a degraded answer (goal #9 covers tool/data
        // failures, not "you don't own this asset").
        if (error instanceof ForbiddenError || error instanceof AssetNotFoundError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : 'copilot tool call failed';
        warnings.push(message);
        explanation = {
          summary: `I could not retrieve data for this asset.`,
          reasoning: message,
          evidence: [],
          suggestedAction: 'Try again, or verify the asset exists and you have access to it.',
          confidence: 0,
        };
      }
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'copilot.gathering',
      agentId: 'copilot-agent',
      status: 'SUCCESS',
      output: { intent, assetId, sourceAgents },
    });

    const answer = await generateAnswer({ question: input.message, explanation });
    await this.memory.appendTurn(input.conversationId, 'assistant', answer);

    await this.memory.setSessionState(input.conversationId, {
      lastAssetId: assetId,
      lastWorkflowId: triggeredWorkflow?.workflowId ?? session?.lastWorkflowId,
      lastIntent: intent,
      lastRecommendationId: recommendationId,
      lastQuestion: input.message,
      updatedAt: new Date().toISOString(),
    });

    const status =
      warnings.length > 0 && explanation.confidence === 0
        ? 'FAILED'
        : warnings.length > 0
          ? 'PARTIAL'
          : 'SUCCESS';
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const confidenceScore = explanation.confidence / 100;

    await this.memory.recordRun({
      conversationId: input.conversationId,
      assetId,
      status,
      intent,
      question: input.message,
      triggeredWorkflowId: triggeredWorkflow?.workflowId,
      agentsUsed: [...new Set(sourceAgents)],
      startedAt,
      finishedAt,
      durationMs,
      confidenceScore,
      warnings,
      errors: [],
    });
    this.telemetry.recordRun({ status, intent, durationMs });

    return {
      status,
      answer,
      explanation,
      intent,
      assetId,
      conversationId: input.conversationId,
      triggeredWorkflow,
      sourceAgents: [...new Set(sourceAgents)],
      citations: citationIds.length > 0 ? [...new Set(citationIds)] : undefined,
      metadata: { startedAt, finishedAt, durationMs },
      confidenceScore,
      warnings,
      errors: [],
    };
  }

  // Executes the tool `selectTool()` chose and builds an Explanation
  // directly from its result (Phase 24 spec #8). Runs through
  // `this.toolExecutor.run()`, not `callTool()` — ToolExecutor never
  // throws, enforces the copilot-agent tool allowlist
  // (agent-tool-access.ts), and records a ToolExecutionTrace row, none of
  // which the internal `callTool()` retry-wrapper does. A denied or
  // failed tool call degrades to a low-confidence explanation rather than
  // failing the conversation, same graceful-degradation contract as
  // every other branch in this executor.
  private async runSelectedTool(
    selection: ToolSelection,
    assetId: string,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<{ explanation: CopilotExplanation; sourceAgents: string[] }> {
    switch (selection.kind) {
      case 'github_issues':
      case 'github_pull_requests':
      case 'github_branches': {
        const repo = await this.resolvePrimaryRepo(assetId, orchestrationContext, aiContext);
        if (!repo) {
          return {
            sourceAgents: [],
            explanation: {
              summary: 'No connected GitHub account/repository found for this asset.',
              reasoning:
                'GitHub-backed tools need a connected account with at least one repository.',
              evidence: [],
              suggestedAction: 'Connect a GitHub account to this asset first.',
              confidence: 20,
            },
          };
        }
        const toolName =
          selection.kind === 'github_issues'
            ? 'github_list_issues'
            : selection.kind === 'github_pull_requests'
              ? 'github_list_pull_requests'
              : 'github_repo_branches';
        const result = await this.toolExecutor.run(
          toolName,
          { accountId: repo.accountId, repo: repo.fullName },
          aiContext,
          'copilot-agent',
        );
        return {
          explanation: this.explanationFromToolResult(toolName, result),
          sourceAgents: ['github'],
        };
      }
      case 'knowledge_findings': {
        const result = await this.toolExecutor.run(
          'knowledge_search',
          { question: selection.query, assetId, documentTypes: ['FINDING'], topK: 5 },
          aiContext,
          'copilot-agent',
        );
        return {
          explanation: this.explanationFromToolResult('knowledge_search', result),
          sourceAgents: ['knowledge_search'],
        };
      }
      case 'count_findings': {
        // A fixed, code-authored query with a validated, safe-to-embed
        // assetId — never the caller's raw message text — is what
        // postgres_query actually runs, per this tool's own "never a
        // query built from raw user input" design note.
        if (!/^[a-z0-9_-]+$/i.test(assetId)) {
          return {
            sourceAgents: [],
            explanation: {
              summary: 'Could not count findings — invalid asset id.',
              reasoning: 'assetId failed a basic safety check before being used in a SQL query.',
              evidence: [],
              suggestedAction: 'Retry with a valid asset.',
              confidence: 0,
            },
          };
        }
        const sql = `SELECT COUNT(*) as count FROM "Finding" f JOIN "Resource" r ON f."resourceId" = r.id WHERE r."assetId" = '${assetId}' AND f.status = 'OPEN'`;
        const result = await this.toolExecutor.run(
          'postgres_query',
          { sql },
          aiContext,
          'copilot-agent',
        );
        return {
          explanation: this.explanationFromToolResult('postgres_query', result),
          sourceAgents: ['postgres_query'],
        };
      }
    }
  }

  // Resolves the asset's connected GitHub account and its first
  // repository — GitHub-tool auto-selection targets that one repository
  // rather than asking the user to disambiguate, a deliberate demo-scale
  // simplification (see docs). Returns undefined (never throws) when
  // there's no connected account, same "degrade gracefully" contract
  // tryTriggerWorkflow() already follows.
  private async resolvePrimaryRepo(
    assetId: string,
    orchestrationContext: OrchestrationContext,
    aiContext: AIContext,
  ): Promise<{ accountId: string; fullName: string } | undefined> {
    const accounts = await accountRepository.findByAsset(assetId, { page: 1, limit: 1 });
    const account = accounts.items[0];
    if (!account) return undefined;

    const result = await this.toolExecutor.run(
      'github_repository_info',
      { accountId: account.id },
      aiContext,
      'copilot-agent',
    );
    if (!result.success) return undefined;
    const output = result.output as { repositories: { fullName: string }[] };
    const repo = output.repositories[0];
    if (!repo) return undefined;
    return { accountId: account.id, fullName: repo.fullName };
  }

  // Turns a ToolResult into a deterministic Explanation — success
  // renders the tool's own output as evidence text, failure renders the
  // tool's error as a low-confidence explanation. Kept generic (works
  // for any tool's output shape) rather than one branch per tool.
  private explanationFromToolResult(
    toolName: string,
    result: {
      success: boolean;
      output?: unknown;
      error?: string;
    },
  ): CopilotExplanation {
    if (!result.success) {
      return {
        summary: `The "${toolName}" tool call failed.`,
        reasoning: result.error ?? 'Unknown tool error.',
        evidence: [],
        suggestedAction: 'Try again, or ask a different question.',
        confidence: 0,
      };
    }
    const evidence = summarizeToolOutput(result.output);
    return {
      summary: `Here is what "${toolName}" returned.`,
      reasoning: evidence.length > 0 ? evidence.join('; ') : 'The tool returned no results.',
      evidence,
      suggestedAction: evidence.length > 0 ? 'Review the results above.' : 'No action needed.',
      confidence: evidence.length > 0 ? 85 : 60,
    };
  }

  // Semantic grounding lookup (Phase 23 spec #6) — calls the generic
  // `knowledge_search` Tool (Phase 24 spec #7: "agents should use it
  // through the Tool framework instead of directly") rather than
  // importing RetrievalService itself, scoped to one already-authorized
  // asset. Swallows its own errors: a Retrieval Service outage should
  // degrade Copilot to its pre-Phase-23 (ungrounded) behavior, not fail
  // the conversation.
  private async retrieveGrounding(
    question: string,
    assetId: string,
    conversationId: string,
    aiContext: AIContext,
  ): Promise<{ id: string; text: string }[]> {
    try {
      const result = await this.callTool<{ documents: { id: string; text: string }[] }>(
        'knowledge_search',
        { question, assetId, topK: 3, conversationId },
        aiContext,
      );
      return result.documents.map((doc) => ({ id: doc.id, text: doc.text }));
    } catch {
      return [];
    }
  }

  // Intelligent Routing (goal #4) — runs the given workflow through the
  // exact same OrchestratorService/WorkflowEngine every multi-step run
  // uses (no direct agent-to-agent call). Resolves a connected account
  // for Discovery's own accountId fallback (discovery.agent.ts). Returns
  // undefined (never throws) when there's no connected account to
  // discover from — the caller degrades gracefully rather than crashing
  // the conversation (goal #9).
  private async tryTriggerWorkflow(
    workflowId: string,
    assetId: string,
    orchestrationContext: OrchestrationContext,
  ): Promise<CopilotTriggeredWorkflow | undefined> {
    const requester: Requester = {
      id: orchestrationContext.user.id,
      role: orchestrationContext.user.role as Requester['role'],
    };
    const accounts = await accountRepository.findByAsset(assetId, { page: 1, limit: 1 });
    const account = accounts.items[0];
    if (!account) {
      return undefined;
    }

    this.telemetry.recordWorkflowTriggered(workflowId);
    const result = await orchestratorFoundation.service.execute({
      intent: workflowId,
      user: requester,
      conversationId: orchestrationContext.conversationId,
      connectedAccounts: [{ id: account.id, provider: account.provider }],
      assets: [{ id: assetId }],
    });
    return { workflowId, executionId: result.executionId, status: result.status };
  }

  // Builds the deterministic Explanation for the resolved intent —
  // summary/reasoning/evidence/suggestedAction/confidence, always from
  // already-computed data (a tool call over an existing service, same
  // "never invented" principle every sibling agent's tools follow).
  private async gatherExplanation(
    intent: CopilotIntent,
    assetId: string,
    message: string,
    aiContext: AIContext,
  ): Promise<{
    explanation: CopilotExplanation;
    sourceAgents: string[];
    recommendationId?: string;
  }> {
    switch (intent) {
      case 'EXPLAIN_RISK':
      case 'ANALYZE': {
        const risk = await this.callTool<RiskLookupResult>(
          'copilot_risk_lookup',
          { assetId },
          aiContext,
        );
        const topTitles = risk.topFindings.map((f) => `${f.severity}: ${f.title}`);
        return {
          sourceAgents: ['risk-agent'],
          explanation: {
            summary: `Overall risk score is ${risk.overallScore}, with ${risk.counts.critical} critical and ${risk.counts.high} high-severity open finding(s).`,
            reasoning:
              topTitles.length > 0
                ? `The highest-priority findings are: ${topTitles.join('; ')}.`
                : 'No open findings are currently recorded for this asset.',
            evidence: topTitles,
            suggestedAction:
              topTitles.length > 0
                ? `Address "${risk.topFindings[0].title}" first — it carries the highest severity.`
                : 'No action needed right now.',
            confidence: topTitles.length > 0 ? 90 : 60,
          },
        };
      }
      case 'EXPLAIN_COMPLIANCE': {
        const compliance = await this.callTool<ComplianceLookupResult>(
          'copilot_compliance_lookup',
          { assetId },
          aiContext,
        );
        const failures = compliance.policyFailures.map((f) => `${f.policyName}: ${f.reason}`);
        return {
          sourceAgents: ['compliance-agent'],
          explanation: {
            summary: `Compliance score is ${compliance.complianceScore} (${compliance.passCount} passed, ${compliance.failCount} failed).`,
            reasoning:
              failures.length > 0
                ? `Failed checks: ${failures.join('; ')}.`
                : 'No policy failures are currently recorded for this asset.',
            evidence: failures,
            suggestedAction:
              failures.length > 0
                ? `Resolve "${compliance.policyFailures[0].policyName}" first.`
                : 'No action needed right now.',
            confidence: failures.length > 0 ? 90 : 60,
          },
        };
      }
      case 'EXPLAIN_RECOMMENDATION': {
        const rec = await this.callTool<RecommendationLookupResult>(
          'copilot_recommendation_lookup',
          { assetId },
          aiContext,
        );
        const requestedIndex = extractRecommendationIndex(message);
        const picked =
          requestedIndex !== undefined
            ? rec.recommendations[requestedIndex - 1]
            : rec.recommendations[0];
        if (!picked) {
          return {
            sourceAgents: ['recommendation-agent'],
            explanation: {
              summary: 'There are no open recommendations for this asset right now.',
              reasoning: 'No Recommendation rows are currently open.',
              evidence: [],
              suggestedAction: 'No action needed right now.',
              confidence: 60,
            },
          };
        }
        return {
          sourceAgents: ['recommendation-agent'],
          recommendationId: picked.id,
          explanation: {
            summary: picked.title,
            reasoning: picked.description,
            evidence: [
              `Priority: ${picked.priority}`,
              `Estimated impact: ${picked.estimatedImpact}`,
            ],
            suggestedAction: picked.title,
            confidence: 90,
          },
        };
      }
      case 'SUMMARIZE_REPORT': {
        const risk = await this.callTool<RiskLookupResult>(
          'copilot_risk_lookup',
          { assetId },
          aiContext,
        );
        const compliance = await this.callTool<ComplianceLookupResult>(
          'copilot_compliance_lookup',
          { assetId },
          aiContext,
        );
        const rec = await this.callTool<RecommendationLookupResult>(
          'copilot_recommendation_lookup',
          { assetId },
          aiContext,
        );
        return {
          sourceAgents: ['risk-agent', 'compliance-agent', 'recommendation-agent'],
          explanation: {
            summary: `Risk score ${risk.overallScore}, compliance score ${compliance.complianceScore}, ${rec.total} open recommendation(s).`,
            reasoning: `${risk.counts.critical + risk.counts.high} critical/high risk finding(s) and ${compliance.failCount} failed compliance check(s) are currently open.`,
            evidence: [
              `Risk: ${risk.overallScore}`,
              `Compliance: ${compliance.complianceScore}`,
              `Open recommendations: ${rec.total}`,
            ],
            suggestedAction: rec.recommendations[0]?.title ?? 'No action needed right now.',
            confidence: 85,
          },
        };
      }
      default: {
        const asset = await this.callTool<AssetLookupResult>(
          'copilot_asset_lookup',
          { assetId },
          aiContext,
        );
        return {
          sourceAgents: ['copilot-agent'],
          explanation: {
            summary: `This asset has ${asset.resourceCount} discovered resource(s).`,
            reasoning: 'Ask about risk, compliance, or recommendations for a more specific answer.',
            evidence: [],
            suggestedAction: 'Ask a more specific question, e.g. "what is the biggest risk?"',
            confidence: 50,
          },
        };
      }
    }
  }

  // Ownership errors (ForbiddenError/AssetNotFoundError, surfaced via
  // ToolExecutionError.cause since ToolRegistry.execute() wraps every
  // tool failure) are re-thrown as themselves rather than degrading into
  // a low-confidence chat answer — "you don't own this asset" must
  // become a 403/404 at the route layer, never a conversational
  // response. Every other tool failure is caught by run()'s own
  // try/catch and degrades gracefully (goal #9).
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
      if (
        error instanceof ToolExecutionError &&
        (error.cause instanceof ForbiddenError || error.cause instanceof AssetNotFoundError)
      ) {
        throw error.cause;
      }
      throw error;
    }
  }
}

// Renders an arbitrary tool output object as a short list of evidence
// strings for explanationFromToolResult() — generic over shape (a
// GitHub issues list, a knowledge_search result, a postgres_query row
// set) rather than one formatter per tool, since new tools will keep
// being added to the framework. Arrays of objects render one line per
// item (first few string/number fields joined); anything else falls
// back to a single JSON line.
function summarizeToolOutput(output: unknown, limit = 10): string[] {
  if (!output || typeof output !== 'object') return [];
  const container = Object.values(output as Record<string, unknown>).find((value) =>
    Array.isArray(value),
  ) as unknown[] | undefined;
  const items = container ?? [output];

  return items.slice(0, limit).map((item) => {
    if (item && typeof item === 'object') {
      const parts = Object.entries(item as Record<string, unknown>)
        .filter(
          (entry): entry is [string, string | number] =>
            typeof entry[1] === 'string' || typeof entry[1] === 'number',
        )
        .slice(0, 4)
        .map(([key, value]) => `${key}: ${value}`);
      return parts.length > 0 ? parts.join(', ') : JSON.stringify(item);
    }
    return String(item);
  });
}
