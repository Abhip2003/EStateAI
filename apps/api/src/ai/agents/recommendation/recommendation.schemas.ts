import { z } from 'zod';

export const assetIdInputSchema = z.object({
  assetId: z.string().min(1),
});

const priorityEnum = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);

export const recommendationViewSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  title: z.string(),
  description: z.string(),
  estimatedImpact: z.string(),
  priority: priorityEnum,
  status: z.enum(['OPEN', 'RESOLVED']),
  sourceAgents: z.array(z.string()),
  sourceFindingIds: z.array(z.string()),
  relatedCompliancePolicyCodes: z.array(z.string()),
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  createdAt: z.string(),
});

// RecommendationEngineTool — the existing, persisted Recommendation rows
// for an asset (services/analysis/recommendation.service.ts, unchanged).
// Never generates a new recommendation; that only ever happens as a
// side-effect of FindingService.evaluateResources().
export const recommendationEngineToolOutputSchema = z.object({
  recommendations: z.array(
    z.object({
      id: z.string(),
      findingId: z.string(),
      title: z.string(),
      description: z.string(),
      estimatedImpact: z.string(),
      priority: priorityEnum,
      status: z.enum(['OPEN', 'RESOLVED']),
      createdAt: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const findingLookupToolOutputSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      resourceId: z.string(),
      ruleCode: z.string(),
      severity: z.string(),
      title: z.string(),
      confidence: z.number(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const assetLookupToolOutputSchema = z.object({
  assetId: z.string(),
  resourceCount: z.number().int().nonnegative(),
  resourcesByType: z.record(z.string(), z.number().int().nonnegative()),
});

export const recommendationAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  assetId: z.string(),
  recommendations: z.array(recommendationViewSchema),
  prioritized: z.array(recommendationViewSchema),
  handoffSources: z.array(
    z.object({
      agentId: z.string(),
      used: z.boolean(),
      origin: z.enum(['context', 'fallback', 'unavailable']),
    }),
  ),
  metadata: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  summary: z.string(),
  confidenceScore: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export const recommendationSummaryVariablesSchema = z.object({
  assetId: z.string(),
  recommendationCount: z.number(),
  topTitles: z.string(),
});
