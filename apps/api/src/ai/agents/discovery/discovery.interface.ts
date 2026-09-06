import type { AIContext } from '../../types/context.types.js';
import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import type {
  DiscoveryAgentResource,
  DiscoverySummaryRecord,
  DiscoveryFailureRecord,
  LanguageSummary,
  TopicSummary,
  RelationshipSummary,
  DiscoveryRunStatus,
} from './discovery.types.js';

export interface DiscoveryExecutorInput {
  accountId: string;
  refresh?: boolean;
}

// Full structured result the Discovery Agent returns — a strict superset
// of the Phase 17 placeholder `DiscoveryAgent` interface's fixed
// `{resourceCount, resources}` output, so `DiscoveryAgentImpl` remains
// assignable to that contract while carrying everything the Phase 18
// spec's "OUTPUT" section asks for.
export interface DiscoveryAgentOutput {
  status: DiscoveryRunStatus;
  provider: string;
  accountId: string;
  resourceCount: number;
  resources: DiscoveryAgentResource[];
  repositories: DiscoveryAgentResource[];
  organizations: DiscoveryAgentResource[];
  languages: LanguageSummary[];
  topics: TopicSummary[];
  relationships: RelationshipSummary;
  metadata: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    refresh: boolean;
  };
  summary: string;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface IDiscoveryExecutor {
  run(
    input: DiscoveryExecutorInput,
    aiContext: AIContext,
    orchestrationContext: OrchestrationContext,
  ): Promise<DiscoveryAgentOutput>;
}

export interface IDiscoveryMemory {
  recordRun(record: DiscoverySummaryRecord): Promise<void>;
  getLastRun(accountId: string): Promise<DiscoverySummaryRecord | undefined>;
  getHistory(accountId: string, limit?: number): Promise<DiscoverySummaryRecord[]>;
  recordFailure(record: DiscoveryFailureRecord): Promise<void>;
  getFailures(accountId: string, limit?: number): Promise<DiscoveryFailureRecord[]>;
  rememberDiscoveredResourceIds(accountId: string, providerResourceIds: string[]): Promise<void>;
  getDiscoveredResourceIds(accountId: string): Promise<string[]>;
  setProviderMetadata(accountId: string, metadata: Record<string, unknown>): Promise<void>;
  getProviderMetadata(accountId: string): Promise<Record<string, unknown> | undefined>;
}
