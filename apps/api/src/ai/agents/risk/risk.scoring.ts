import type { RiskScore } from '../../../generated/prisma/client.js';
import type { BusinessImpact, RiskSeverityCounts } from './risk.types.js';

// Formats the existing RiskScore row (riskService's own computation,
// unchanged) into the agent's output shape. This file never computes a
// score — overallScore and every count below are copied verbatim from
// the persisted row, satisfying the spec's "the LLM must NOT calculate
// risk scores itself... existing backend logic remains the source of
// truth" rule at the deterministic-code layer too, not just the LLM layer.
export function toSeverityCounts(riskScore: RiskScore | null): RiskSeverityCounts {
  if (!riskScore) {
    return { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  }
  return {
    critical: riskScore.criticalCount,
    high: riskScore.highCount,
    medium: riskScore.mediumCount,
    low: riskScore.lowCount,
    informational: riskScore.informationalCount,
  };
}

// Deterministic label derived from already-computed severity counts —
// worst-severity-wins, never a numeric recomputation. This is the
// "estimate business impact" requirement resolved without asking the LLM
// to invent a number; the LLM only narrates what this label means (see
// risk.summary.ts).
export function businessImpactFromCounts(counts: RiskSeverityCounts): BusinessImpact {
  if (counts.critical > 0) return 'SEVERE';
  if (counts.high > 0) return 'HIGH';
  if (counts.medium > 0) return 'MODERATE';
  if (counts.low > 0 || counts.informational > 0) return 'LOW';
  return 'MINIMAL';
}
