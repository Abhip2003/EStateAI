import type { RiskAgentOutput } from '../agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../agents/recommendation/recommendation.interface.js';
import type { BusinessImpact } from '../agents/risk/risk.types.js';
import type { ConsensusConflict } from './consensus.types.js';

// Pure, deterministic scoring heuristics the Consensus Engine assembles
// into a ConsensusReport — documented heuristics in the same spirit as
// ai/critic/confidence.ts's aggregateConfidence() and
// ai/planner/goal-planner.ts's own confidence estimates: never an LLM
// judgment call, always derived from fields the wrapped agents already
// computed. Exported individually (not just as one big compute()) so
// debate.engine.ts's trigger check (spec #5's "multiple agents disagree")
// can reuse deriveConflicts() directly without duplicating the logic.

const BUSINESS_IMPACT_RANK: Record<BusinessImpact, number> = {
  SEVERE: 5,
  HIGH: 4,
  MODERATE: 3,
  LOW: 2,
  MINIMAL: 1,
};

export function isHighOrAboveRisk(businessImpact: BusinessImpact): boolean {
  return BUSINESS_IMPACT_RANK[businessImpact] >= BUSINESS_IMPACT_RANK.HIGH;
}

// A finding is "accepted" (corroborated) if the Recommendation Agent's
// own cross-referencing (built in Phase 20/21, unmodified here) actually
// produced a recommendation citing it — i.e. another agent's existing
// business logic, not this module, decided the finding mattered enough
// to act on. Everything else is "rejected": raised by Risk, but nothing
// downstream corroborated it.
export function classifyFindings(
  risk: RiskAgentOutput,
  recommendation: RecommendationAgentOutput,
): { accepted: string[]; rejected: string[] } {
  const citedFindingIds = new Set(recommendation.recommendations.map((rec) => rec.findingId));
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const finding of risk.findings) {
    (citedFindingIds.has(finding.id) ? accepted : rejected).push(finding.id);
  }
  return { accepted, rejected };
}

// Ratio of Risk's own findings that were corroborated — 1.0 (full
// agreement) when Risk raised nothing at all, since there is nothing to
// disagree about.
export function computeAgreementScore(accepted: string[], rejected: string[]): number {
  const total = accepted.length + rejected.length;
  if (total === 0) return 1;
  return accepted.length / total;
}

// Structural cross-checks between the three analytical participants —
// each comparison reads only fields the wrapped agents already computed
// (overallScore/businessImpact, complianceScore, recommendation
// coverage), never recomputing anything an existing agent owns.
export function deriveConflicts(
  risk: RiskAgentOutput,
  compliance: ComplianceAgentOutput,
  recommendation: RecommendationAgentOutput,
): ConsensusConflict[] {
  const conflicts: ConsensusConflict[] = [];

  if (isHighOrAboveRisk(risk.businessImpact) && compliance.complianceScore >= 80) {
    conflicts.push({
      description: `Risk Agent reports business impact "${risk.businessImpact}" (score ${risk.overallScore}) while Compliance Agent reports a high compliance score (${compliance.complianceScore})`,
      agents: ['risk-agent', 'compliance-agent'],
      severity: 'HIGH',
    });
  }

  const criticalOrHighCount = risk.criticalFindings.length + risk.highFindings.length;
  if (criticalOrHighCount > 0 && recommendation.recommendations.length === 0) {
    conflicts.push({
      description: `Risk Agent raised ${criticalOrHighCount} critical/high finding(s) but Recommendation Agent produced no recommendations`,
      agents: ['risk-agent', 'recommendation-agent'],
      severity: 'HIGH',
    });
  }

  if (compliance.failCount > 0 && recommendation.recommendations.length === 0) {
    conflicts.push({
      description: `Compliance Agent reports ${compliance.failCount} failed control(s) but Recommendation Agent produced no recommendations`,
      agents: ['compliance-agent', 'recommendation-agent'],
      severity: 'MEDIUM',
    });
  }

  const { rejected } = classifyFindings(risk, recommendation);
  if (rejected.length > 0) {
    conflicts.push({
      description: `${rejected.length} Risk finding(s) were not corroborated by any Recommendation Agent output`,
      agents: ['risk-agent', 'recommendation-agent'],
      severity: rejected.length > risk.findings.length / 2 ? 'HIGH' : 'LOW',
    });
  }

  return conflicts;
}

// Aggregate participant confidence, discounted by how much they actually
// agreed — mirrors ai/critic/confidence.ts's "weighted blend, documented
// heuristic, not a tuned model" design, but scoped to this module's own
// four confidence signals rather than reusing that function's toolSuccess/
// retrieval-shaped inputs, which don't apply here.
export function computeConsensusConfidence(confidences: number[], agreementScore: number): number {
  if (confidences.length === 0) return agreementScore;
  const average = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  const blended = average * 0.6 + agreementScore * 0.4;
  return Math.max(0, Math.min(1, blended));
}

export function buildReasoningSummary(input: {
  assetId: string;
  agreementScore: number;
  conflicts: ConsensusConflict[];
  accepted: string[];
  rejected: string[];
}): string {
  const parts = [
    `Consensus for asset ${input.assetId}: ${(input.agreementScore * 100).toFixed(0)}% agreement across ${input.accepted.length + input.rejected.length} finding(s).`,
  ];
  if (input.conflicts.length === 0) {
    parts.push('No structural conflicts detected between participants.');
  } else {
    parts.push(
      `${input.conflicts.length} conflict(s) detected: ${input.conflicts.map((c) => c.description).join('; ')}.`,
    );
  }
  if (input.rejected.length > 0) {
    parts.push(`${input.rejected.length} finding(s) rejected (uncorroborated).`);
  }
  return parts.join(' ');
}
