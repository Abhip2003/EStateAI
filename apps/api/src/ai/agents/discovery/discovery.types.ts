// Shared, plain data types for the Discovery Agent — kept separate from
// discovery.schemas.ts (the zod schemas that validate these shapes at
// tool/agent boundaries) and discovery.interface.ts (the class-level
// contracts), matching the file split the Phase 18 spec asked for.

export type DiscoveryAction = 'DISCOVER' | 'REFRESH';

// Result of classifying a free-form discovery request (e.g. "Discover all
// GitHub repositories" / "Refresh repository inventory") — informational
// only in this phase (see discovery.prompts.ts's comment on why this
// isn't LLM-driven yet), used for logging/summary wording rather than
// branching control flow.
export interface DiscoveryIntent {
  action: DiscoveryAction;
  provider?: string;
  confidence: number;
}

// Agent-facing shape of a discovered/persisted resource — a superset of
// the existing services/discovery/dto/discovered-resource.ts's
// `DiscoveredResource`, adding the real persisted `id` once available.
// Never re-derives provider-specific fields itself; always populated from
// data the existing DiscoveryService/ResourceService already produced.
export interface DiscoveryAgentResource {
  id?: string;
  provider: string;
  providerResourceId: string;
  resourceType: string;
  displayName: string;
  description?: string;
  externalUrl?: string;
  metadata: Record<string, unknown>;
}

export interface LanguageSummary {
  language: string;
  repositoryCount: number;
}

export interface TopicSummary {
  topic: string;
  repositoryCount: number;
}

export interface RelationshipSummary {
  created: number;
  updated: number;
  unchanged: number;
}

export type DiscoveryRunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED';

// Persisted (via DiscoveryMemory) summary of one agent run — deliberately
// smaller than the full DiscoveryAgentOutput below, since memory only
// needs to answer "what happened last time," not replay every resource.
export interface DiscoverySummaryRecord {
  accountId: string;
  provider: string;
  status: DiscoveryRunStatus;
  resourceCount: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  confidenceScore: number;
  warnings: string[];
  errors: string[];
}

export interface DiscoveryFailureRecord {
  accountId: string;
  message: string;
  timestamp: string;
}

// One future/implemented provider's capability entry in provider.registry.ts.
export interface DiscoveryProviderCapability {
  provider: string;
  implemented: boolean;
  tools: string[];
  description: string;
}
