import { z } from 'zod';

// Zod schemas used both as tool input/output schemas (validated by
// src/ai/tools/tool-registry.ts's execute() call path) and to structure
// the Risk Agent's own final output. Kept separate from risk.types.ts's
// plain TS types, matching the Discovery Agent's file split.

export const assetIdInputSchema = z.object({
  assetId: z.string().min(1),
});

const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);
const businessImpactSchema = z.enum(['SEVERE', 'HIGH', 'MODERATE', 'LOW', 'MINIMAL']);

export const riskFindingViewSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  provider: z.string(),
  ruleCode: z.string(),
  severity: severitySchema,
  status: z.enum(['OPEN', 'RESOLVED']),
  title: z.string(),
  reasoning: z.string(),
  businessImpact: businessImpactSchema,
  evidence: z.array(z.string()),
  priority: businessImpactSchema,
  confidence: z.number().min(0).max(100),
  repeated: z.boolean(),
  createdAt: z.string(),
});

export const riskSeverityCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  informational: z.number().int().nonnegative(),
});

// RiskEngineTool — reads the existing RiskScore row for an asset
// (riskService.getForAsset), the source of truth for overallScore/counts.
export const riskEngineToolOutputSchema = z.object({
  overallScore: z.number().min(0).max(100),
  counts: riskSeverityCountsSchema,
});

// AssetLookupTool — confirms ownership and returns the resources
// currently attached to the asset (already-persisted DiscoveryService
// output), giving the agent the asset context it needs without
// re-fetching from any external provider.
export const assetLookupToolOutputSchema = z.object({
  assetId: z.string(),
  resourceCount: z.number().int().nonnegative(),
  resourcesByType: z.record(z.string(), z.number().int().nonnegative()),
});

// FindingStoreTool — lists the existing OPEN Findings for an asset
// (findingService.list), the source of truth for what security problems
// exist. Never creates or recalculates a finding itself.
export const findingStoreToolOutputSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      resourceId: z.string(),
      provider: z.string(),
      ruleCode: z.string(),
      severity: severitySchema,
      status: z.enum(['OPEN', 'RESOLVED']),
      title: z.string(),
      description: z.string(),
      confidence: z.number(),
      createdAt: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

// RepositoryRiskTool — groups the same already-fetched findings by
// resource, a read-only aggregation over FindingStoreTool's data.
export const repositoryRiskToolOutputSchema = z.object({
  repositories: z.array(
    z.object({
      resourceId: z.string(),
      findingCount: z.number().int().nonnegative(),
      highestSeverity: severitySchema.nullable(),
    }),
  ),
});

// Every not-yet-implemented risk tool (secrets scanning, branch
// protection, workflow risk, dependency risk, security alerts) shares
// this permissive output shape — execute() always rejects (see
// risk.tool.ts), so the schema only needs to type-check.
export const placeholderRiskToolOutputSchema = z.object({}).passthrough();

export const riskAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  assetId: z.string(),
  overallScore: z.number().min(0).max(100),
  businessImpact: businessImpactSchema,
  counts: riskSeverityCountsSchema,
  findings: z.array(riskFindingViewSchema),
  criticalFindings: z.array(riskFindingViewSchema),
  highFindings: z.array(riskFindingViewSchema),
  mediumFindings: z.array(riskFindingViewSchema),
  lowFindings: z.array(riskFindingViewSchema),
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

export const riskSummaryVariablesSchema = z.object({
  assetId: z.string(),
  overallScore: z.number(),
  businessImpact: businessImpactSchema,
  findingCount: z.number(),
  criticalCount: z.number(),
  highCount: z.number(),
  mediumCount: z.number(),
  lowCount: z.number(),
});

export const riskFindingExplanationVariablesSchema = z.object({
  title: z.string(),
  ruleCode: z.string(),
  severity: severitySchema,
  resourceId: z.string(),
  defaultReasoning: z.string(),
});
