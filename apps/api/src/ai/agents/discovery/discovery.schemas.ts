import { z } from 'zod';

// Zod schemas used both as tool input/output schemas (validated by
// src/ai/tools/tool-registry.ts's execute() call path) and to structure
// the Discovery Agent's own final output. Kept separate from
// discovery.types.ts's plain TS types so the two can be cross-checked —
// `z.infer` below is asserted against the hand-written types at compile
// time via the `satisfies`-free structural checks TypeScript already
// performs on assignment.

export const accountIdInputSchema = z.object({
  accountId: z.string().min(1),
});

export const discoveryAgentResourceSchema = z.object({
  id: z.string().optional(),
  provider: z.string(),
  providerResourceId: z.string(),
  resourceType: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  externalUrl: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
});

export const githubRepositoryToolOutputSchema = z.object({
  success: z.boolean(),
  resourceCount: z.number().int().nonnegative(),
  repositories: z.array(discoveryAgentResourceSchema),
  organizations: z.array(discoveryAgentResourceSchema),
  relationships: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export const githubOrganizationToolOutputSchema = z.object({
  organizations: z.array(discoveryAgentResourceSchema),
});

export const languageSummarySchema = z.object({
  language: z.string(),
  repositoryCount: z.number().int().nonnegative(),
});

export const githubLanguageToolOutputSchema = z.object({
  languages: z.array(languageSummarySchema),
});

export const topicSummarySchema = z.object({
  topic: z.string(),
  repositoryCount: z.number().int().nonnegative(),
});

export const githubTopicToolOutputSchema = z.object({
  topics: z.array(topicSummarySchema),
});

// Every not-yet-implemented tool (branches, contributors, releases,
// workflows, security, secrets) shares this permissive output shape —
// execute() always rejects (see github.tool.ts), so the schema only needs
// to type-check, never actually validate real data in this phase.
export const placeholderToolOutputSchema = z.object({}).passthrough();

export const discoveryIntentSchema = z.object({
  action: z.enum(['DISCOVER', 'REFRESH']),
  provider: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const discoveryAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  provider: z.string(),
  accountId: z.string(),
  resourceCount: z.number().int().nonnegative(),
  resources: z.array(discoveryAgentResourceSchema),
  repositories: z.array(discoveryAgentResourceSchema),
  organizations: z.array(discoveryAgentResourceSchema),
  languages: z.array(languageSummarySchema),
  topics: z.array(topicSummarySchema),
  relationships: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  metadata: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    refresh: z.boolean(),
  }),
  summary: z.string(),
  confidenceScore: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export const discoverySummaryVariablesSchema = z.object({
  provider: z.string(),
  resourceCount: z.number(),
  repositoryCount: z.number(),
  organizationCount: z.number(),
  warningCount: z.number(),
  errorCount: z.number(),
});
