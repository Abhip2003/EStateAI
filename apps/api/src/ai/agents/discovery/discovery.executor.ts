import type { AIContext } from '../../types/context.types.js';
import { recordExecutionStep } from '../../context/ai-context-builder.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { withRetry } from '../../utils/retry.js';
import { ToolExecutionError } from '../../errors/index.js';
import { aiFoundation } from '../../foundation.js';
import { aiConfig } from '../../config/index.js';
import {
  type OrchestrationContext,
  recordAgentOutput,
  recordDecision,
} from '../../orchestrator/execution.context.js';
import { discoveryToolProviderRegistry } from './provider.registry.js';
import { discoverySummaryPrompt } from './discovery.prompts.js';
import { UnsupportedAgentProviderError } from './discovery.errors.js';
import { getOwnedAccount } from '../../../services/assets/account.service.js';
import type { Requester } from '../../../services/assets/ownership.js';
import type {
  IDiscoveryExecutor,
  DiscoveryExecutorInput,
  DiscoveryAgentOutput,
} from './discovery.interface.js';
import type { IDiscoveryMemory } from './discovery.interface.js';
import type { DiscoveryAgentTelemetry } from './discovery.telemetry.js';
import type { DiscoveryAgentResource } from './discovery.types.js';

const TOOL_MAX_ATTEMPTS = 3;
const TOOL_RETRY_BACKOFF_MS = 200;

// Structural failures (unknown/unsupported provider, missing credential)
// will never succeed on retry — only genuinely transient-looking failures
// are worth another attempt.
function isRetryableToolError(error: unknown): boolean {
  if (!(error instanceof ToolExecutionError)) return true;
  const message = error.message.toLowerCase();
  return (
    !message.includes('no discovery provider registered') &&
    !message.includes('no credential is stored')
  );
}

function confidenceFor(input: {
  success: boolean;
  resourceCount: number;
  warningCount: number;
  errorCount: number;
}): number {
  if (!input.success) {
    return input.resourceCount > 0 ? 0.4 : 0;
  }
  if (input.errorCount > 0) return 0.5;
  if (input.warningCount > 0) return 0.75;
  return 1;
}

// Drives one Discovery Agent run: determines the provider, calls the
// GitHub tools (github.tool.ts — themselves thin wrappers over the
// existing DiscoveryService), validates their outputs (already enforced
// by ToolRegistry.execute() against each tool's zod schema), generates a
// summary, computes a confidence score, and records the outcome into
// DiscoveryMemory and telemetry. Relationship building already happens
// inside the reused DiscoveryService/RelationshipService — this class
// only surfaces the resulting counts, it never builds edges itself.
export class DiscoveryExecutor implements IDiscoveryExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly memory: IDiscoveryMemory,
    private readonly telemetry: DiscoveryAgentTelemetry,
  ) {}

  async run(
    input: DiscoveryExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<DiscoveryAgentOutput> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    recordExecutionStep(aiContext, 'discovery.planning', { accountId: input.accountId });

    const requester: Requester = {
      id: aiContext.user.id,
      role: aiContext.user.role as Requester['role'],
    };
    const account = await getOwnedAccount(input.accountId, requester);
    recordDecision(
      orchestrationContext,
      `provider=${account.provider}`,
      'resolved from Account.provider',
    );

    if (!discoveryToolProviderRegistry.isImplemented(account.provider)) {
      const error = new UnsupportedAgentProviderError(account.provider);
      await this.memory.recordFailure({
        accountId: input.accountId,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
      this.telemetry.recordRun({
        status: 'FAILED',
        durationMs: Date.now() - startedAtMs,
        resourceCount: 0,
      });
      // Thrown, not folded into a graceful result — a structural problem
      // resolved before anything is attempted, same treatment the
      // pre-existing discoveryProviderRegistry.getProvider() gives
      // UnsupportedDiscoveryProviderError (see
      // services/discovery/discovery.service.ts). job-executor.ts
      // recognizes this as a PermanentJobError-equivalent (see its
      // isPermanentFailure()), so the enclosing AI_DISCOVERY job goes
      // straight to FAILED instead of retrying a provider mismatch that
      // will never succeed.
      throw error;
    }

    recordExecutionStep(aiContext, 'discovery.executing', { provider: account.provider });

    let repositoryResult;
    try {
      repositoryResult = await this.callTool<{
        success: boolean;
        resourceCount: number;
        repositories: DiscoveryAgentResource[];
        organizations: DiscoveryAgentResource[];
        relationships: { created: number; updated: number; unchanged: number };
        warnings: string[];
        errors: string[];
      }>('github_discover_repositories', { accountId: input.accountId }, aiContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'discovery tool call failed';
      await this.memory.recordFailure({
        accountId: input.accountId,
        message,
        timestamp: new Date().toISOString(),
      });
      return this.finalize({
        status: 'FAILED',
        provider: account.provider,
        accountId: input.accountId,
        startedAt,
        startedAtMs,
        refresh: input.refresh ?? false,
        resources: [],
        repositories: [],
        organizations: [],
        languages: [],
        topics: [],
        relationships: { created: 0, updated: 0, unchanged: 0 },
        warnings: [],
        errors: [message],
      });
    }

    recordAgentOutput(orchestrationContext, {
      stepId: 'discovery.repositories',
      agentId: 'discovery-agent',
      status: repositoryResult.success ? 'SUCCESS' : 'FAILED',
      output: repositoryResult,
    });

    let languages: { language: string; repositoryCount: number }[] = [];
    let topics: { topic: string; repositoryCount: number }[] = [];
    const shapingWarnings: string[] = [];

    try {
      const languageResult = await this.callTool<{ languages: typeof languages }>(
        'github_summarize_languages',
        { accountId: input.accountId },
        aiContext,
      );
      languages = languageResult.languages;
      const topicResult = await this.callTool<{ topics: typeof topics }>(
        'github_summarize_topics',
        { accountId: input.accountId },
        aiContext,
      );
      topics = topicResult.topics;
    } catch (error) {
      // Language/topic summaries are enrichment, not core discovery —
      // their failure degrades gracefully into a warning rather than
      // failing the whole run, since the primary repository discovery
      // above already succeeded and persisted real data.
      shapingWarnings.push(
        `language/topic summarization failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await this.memory.rememberDiscoveredResourceIds(
      input.accountId,
      [...repositoryResult.repositories, ...repositoryResult.organizations].map(
        (r) => r.providerResourceId,
      ),
    );

    const status = repositoryResult.success
      ? repositoryResult.errors.length > 0 || shapingWarnings.length > 0
        ? 'PARTIAL'
        : 'SUCCESS'
      : 'FAILED';

    return this.finalize({
      status,
      provider: account.provider,
      accountId: input.accountId,
      startedAt,
      startedAtMs,
      refresh: input.refresh ?? false,
      resources: [...repositoryResult.repositories, ...repositoryResult.organizations],
      repositories: repositoryResult.repositories,
      organizations: repositoryResult.organizations,
      languages,
      topics,
      relationships: repositoryResult.relationships,
      warnings: [...repositoryResult.warnings, ...shapingWarnings],
      errors: repositoryResult.errors,
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

  private async generateSummary(input: {
    provider: string;
    resourceCount: number;
    repositoryCount: number;
    organizationCount: number;
    warningCount: number;
    errorCount: number;
  }): Promise<string> {
    const fallback = `Discovered ${input.resourceCount} resources from ${input.provider} (${input.repositoryCount} repositories, ${input.organizationCount} organizations)${
      input.errorCount > 0 ? `, with ${input.errorCount} error(s)` : ''
    }${input.warningCount > 0 ? `, ${input.warningCount} warning(s)` : ''}.`;

    try {
      const rendered = discoverySummaryPrompt.render(input);
      const response = await aiFoundation.llmClient.generate({
        model: aiConfig.defaultModel,
        messages: [
          ...(rendered.system ? [{ role: 'system' as const, content: rendered.system }] : []),
          { role: 'user' as const, content: rendered.user },
        ],
        maxTokens: 200,
        temperature: 0.3,
      });
      return response.text.trim() || fallback;
    } catch {
      // No configured LLM provider (e.g. no OPENAI_API_KEY set) is
      // expected in most environments running this agent today — graceful
      // degradation to a deterministic summary, never a failed run.
      return fallback;
    }
  }

  private async finalize(input: {
    status: DiscoveryAgentOutput['status'];
    provider: string;
    accountId: string;
    startedAt: string;
    startedAtMs: number;
    refresh: boolean;
    resources: DiscoveryAgentResource[];
    repositories: DiscoveryAgentResource[];
    organizations: DiscoveryAgentResource[];
    languages: { language: string; repositoryCount: number }[];
    topics: { topic: string; repositoryCount: number }[];
    relationships: { created: number; updated: number; unchanged: number };
    warnings: string[];
    errors: string[];
  }): Promise<DiscoveryAgentOutput> {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - input.startedAtMs;
    const resourceCount = input.resources.length;

    const confidenceScore = confidenceFor({
      success: input.status !== 'FAILED',
      resourceCount,
      warningCount: input.warnings.length,
      errorCount: input.errors.length,
    });

    const summary = await this.generateSummary({
      provider: input.provider,
      resourceCount,
      repositoryCount: input.repositories.length,
      organizationCount: input.organizations.length,
      warningCount: input.warnings.length,
      errorCount: input.errors.length,
    });

    await this.memory.recordRun({
      accountId: input.accountId,
      provider: input.provider,
      status: input.status,
      resourceCount,
      startedAt: input.startedAt,
      finishedAt,
      durationMs,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    });

    this.telemetry.recordRun({ status: input.status, durationMs, resourceCount });

    return {
      status: input.status,
      provider: input.provider,
      accountId: input.accountId,
      resourceCount,
      resources: input.resources,
      repositories: input.repositories,
      organizations: input.organizations,
      languages: input.languages,
      topics: input.topics,
      relationships: input.relationships,
      metadata: {
        startedAt: input.startedAt,
        finishedAt,
        durationMs,
        refresh: input.refresh,
      },
      summary,
      confidenceScore,
      warnings: input.warnings,
      errors: input.errors,
    };
  }
}
