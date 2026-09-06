import { z } from 'zod';

export const assetIdInputSchema = z.object({
  assetId: z.string().min(1),
});

export const assetLookupToolOutputSchema = z.object({
  assetId: z.string(),
  resourceCount: z.number().int().nonnegative(),
  resourcesByType: z.record(z.string(), z.number().int().nonnegative()),
});

const reportSectionSchema = z.object({
  id: z.enum(['discovery-agent', 'risk-agent', 'compliance-agent', 'recommendation-agent']),
  title: z.string(),
  status: z.enum(['INCLUDED', 'MISSING', 'FAILED']),
  origin: z.enum(['context', 'memory', 'unavailable']),
  content: z.string(),
  confidence: z.number().min(0).max(100).optional(),
});

export const reportAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  assetId: z.string(),
  summary: z.string(),
  sections: z.array(reportSectionSchema),
  executive: z.object({
    overallRiskScore: z.number().nullable(),
    complianceScore: z.number().nullable(),
    openFindingsCount: z.number().nullable(),
    recommendationCount: z.number().nullable(),
    topRecommendations: z.array(z.object({ title: z.string(), priority: z.string() })),
  }),
  metadata: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  confidenceScore: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export const reportSummaryVariablesSchema = z.object({
  assetId: z.string(),
  includedSectionCount: z.number(),
  totalSectionCount: z.number(),
  sectionSummaries: z.string(),
});
