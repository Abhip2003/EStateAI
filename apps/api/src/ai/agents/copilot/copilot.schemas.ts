import { z } from 'zod';

export const chatInputSchema = z.object({
  assetId: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  message: z.string().min(1),
});

const intentSchema = z.enum([
  'EXPLAIN_RISK',
  'EXPLAIN_COMPLIANCE',
  'EXPLAIN_RECOMMENDATION',
  'SUMMARIZE_REPORT',
  'ANALYZE',
  'FOLLOW_UP',
  'GENERAL',
]);

export const explanationSchema = z.object({
  summary: z.string(),
  reasoning: z.string(),
  evidence: z.array(z.string()),
  suggestedAction: z.string(),
  confidence: z.number().min(0).max(100),
});

export const copilotAgentOutputSchema = z.object({
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  answer: z.string(),
  explanation: explanationSchema,
  intent: intentSchema,
  assetId: z.string().optional(),
  conversationId: z.string(),
  triggeredWorkflow: z
    .object({ workflowId: z.string(), executionId: z.string(), status: z.string() })
    .optional(),
  sourceAgents: z.array(z.string()),
  citations: z.array(z.string()).optional(),
  metadata: z.object({
    startedAt: z.string(),
    finishedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  confidenceScore: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

// Tool schemas — every tool wraps an existing service, mirroring the
// risk/compliance/recommendation tool files' own input/output schemas.
export const assetIdInputSchema = z.object({ assetId: z.string().min(1) });

export const riskLookupToolOutputSchema = z.object({
  overallScore: z.number(),
  counts: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    informational: z.number(),
  }),
  topFindings: z.array(
    z.object({ id: z.string(), title: z.string(), severity: z.string(), resourceId: z.string() }),
  ),
});

export const complianceLookupToolOutputSchema = z.object({
  complianceScore: z.number(),
  passCount: z.number(),
  failCount: z.number(),
  policyFailures: z.array(
    z.object({
      policyCode: z.string(),
      policyName: z.string(),
      resourceId: z.string(),
      reason: z.string(),
    }),
  ),
});

export const recommendationLookupToolOutputSchema = z.object({
  recommendations: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      estimatedImpact: z.string(),
      priority: z.string(),
    }),
  ),
  total: z.number(),
});

export const assetLookupToolOutputSchema = z.object({
  assetId: z.string(),
  resourceCount: z.number().int().nonnegative(),
});

export const answerVariablesSchema = z.object({
  question: z.string(),
  summary: z.string(),
  reasoning: z.string(),
  evidence: z.string(),
  suggestedAction: z.string(),
});
