import { z } from 'zod';

// Zod schemas used both as tool input/output schemas (validated by
// src/ai/tools/tool-registry.ts's execute() call path) and to structure
// the Compliance Agent's own final output. Kept separate from
// compliance.types.ts's plain TS types, matching Discovery/Risk Agents'
// file split.

export const assetIdInputSchema = z.object({
  assetId: z.string().min(1),
});

const frameworkSchema = z.enum(['NIST_CSF', 'CIS_CONTROLS', 'ISO_27001', 'SOC2']);
const controlStatusSchema = z.enum(['PASS', 'FAIL', 'MISSING']);
const prioritySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export const frameworkControlSchema = z.object({
  framework: frameworkSchema,
  controlId: z.string(),
  controlName: z.string(),
});

export const complianceControlViewSchema = z.object({
  framework: frameworkSchema,
  controlId: z.string(),
  controlName: z.string(),
  status: controlStatusSchema,
  policyCode: z.string().optional(),
  policyName: z.string().optional(),
  resourceId: z.string().optional(),
  reasoning: z.string(),
  evidence: z.array(z.string()),
  priority: prioritySchema,
  confidence: z.number().min(0).max(100),
});

const policyOutcomeSchema = z.object({
  policyCode: z.string(),
  policyName: z.string(),
  resourceId: z.string(),
  reason: z.string(),
});

// ComplianceEngineTool — reads the existing ComplianceReport for an asset
// via the existing ComplianceService. complianceScore/counts are the
// source of truth, never recalculated by this agent.
export const complianceEngineToolOutputSchema = z.object({
  complianceScore: z.number().min(0).max(100),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  notApplicableCount: z.number().int().nonnegative(),
  policyFailures: z.array(policyOutcomeSchema),
  policyPasses: z.array(policyOutcomeSchema),
});

// PolicyLookupTool — the existing, enabled policy catalog (read-only).
export const policyLookupToolOutputSchema = z.object({
  policies: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      provider: z.string(),
      severity: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

// FindingLookupTool — the risk findings this agent's compliance
// assessment is contextualized against (existing FindingService, unchanged).
export const findingLookupToolOutputSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string(),
      resourceId: z.string(),
      ruleCode: z.string(),
      severity: z.string(),
      title: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

// AssetLookupTool — confirms ownership and returns discovered-resource
// counts, the "Asset Metadata" input the spec calls out.
export const assetLookupToolOutputSchema = z.object({
  assetId: z.string(),
  resourceCount: z.number().int().nonnegative(),
  resourcesByType: z.record(z.string(), z.number().int().nonnegative()),
});

// FrameworkMappingTool — static compliance.mapping.ts data, no DB call.
export const frameworkMappingToolOutputSchema = z.object({
  controls: z.array(frameworkControlSchema),
});

// ControlCoverageTool — the per-framework passed/failed/missing control
// breakdown, derived from ComplianceReport's policy outcomes plus the
// static mapping table.
export const controlCoverageToolOutputSchema = z.object({
  framework: frameworkSchema,
  name: z.string(),
  passedControls: z.array(complianceControlViewSchema),
  failedControls: z.array(complianceControlViewSchema),
  missingControls: z.array(complianceControlViewSchema),
  coveragePercent: z.number().min(0).max(100),
});

// EvidenceTool — evidence strings for one control, sourced from the
// underlying PolicyResult's own reason text (existing data, reformatted).
export const evidenceToolOutputSchema = z.object({
  evidence: z.array(z.string()),
});

// ComplianceStoreTool — the raw persisted PolicyResult rows for an asset
// (existing policyResultRepository, unchanged) — the actual compliance
// "store," distinct from ComplianceEngineTool's aggregated report.
export const complianceStoreToolOutputSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      policyId: z.string(),
      resourceId: z.string(),
      status: z.string(),
      reason: z.string(),
      evaluatedAt: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const complianceFrameworkResultSchema = z.object({
  framework: frameworkSchema,
  name: z.string(),
  passedControls: z.array(complianceControlViewSchema),
  failedControls: z.array(complianceControlViewSchema),
  missingControls: z.array(complianceControlViewSchema),
  coveragePercent: z.number().min(0).max(100),
});

export const complianceAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  assetId: z.string(),
  complianceScore: z.number().min(0).max(100),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  notApplicableCount: z.number().int().nonnegative(),
  policyFailures: z.array(policyOutcomeSchema),
  policyPasses: z.array(policyOutcomeSchema),
  frameworks: z.array(complianceFrameworkResultSchema),
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

export const complianceSummaryVariablesSchema = z.object({
  assetId: z.string(),
  complianceScore: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  warningCount: z.number(),
  frameworkCount: z.number(),
});

export const complianceGapExplanationVariablesSchema = z.object({
  controlName: z.string(),
  framework: z.string(),
  policyName: z.string().optional(),
  status: z.string(),
  defaultReasoning: z.string(),
});
