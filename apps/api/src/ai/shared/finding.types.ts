// Phase 20 — Multi-Agent Collaboration. A single, normalized "Finding"
// shape that Discovery/Risk/Compliance Agent outputs can all be adapted
// into (see finding.adapters.ts), so Recommendation/Report Agents can
// consume upstream results without knowing each source agent's own
// output shape. This is a read-only, in-memory projection built at
// handoff time — it never replaces or persists over the existing Finding
// Prisma model (services/analysis) or PolicyResult; those remain the
// durable source of truth.
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

export type FindingCategory = 'RISK' | 'COMPLIANCE' | 'DISCOVERY';

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  category: FindingCategory;
  description: string;
  resourceId?: string;
  evidence: string[];
  confidence: number;
  agent: string;
  timestamp: string;
  // Original source identifiers (ruleCode for Risk, policyCode for
  // Compliance) — kept so Recommendation Agent can cross-reference this
  // Finding back to the existing Recommendation template / policy row it
  // came from, without re-deriving it.
  sourceCode?: string;
}
