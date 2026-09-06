import type { SeverityCounts } from '../../analysis/dto/risk-score.js';

export type ComplianceScope = 'ASSET' | 'ACCOUNT' | 'PROVIDER' | 'OVERALL';

export interface PolicyOutcome {
  policyCode: string;
  policyName: string;
  resourceId: string;
  reason: string;
}

// Resources bucketed by their RESOURCE-scope RiskScore.overallScore — a
// coarser view than severityDistribution (which counts findings, not
// resources), reusing Phase 6A's RiskScore rows rather than recomputing
// risk from scratch.
export interface RiskDistribution {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

// Computed on read from current PolicyResult/Finding/RiskScore rows —
// there is no persisted "compliance snapshot" table, unlike RiskScore.
export interface ComplianceReport {
  scope: ComplianceScope;
  passCount: number;
  failCount: number;
  warningCount: number;
  notApplicableCount: number;
  // 0-100. See ComplianceService for the exact formula.
  complianceScore: number;
  policyFailures: PolicyOutcome[];
  policyPasses: PolicyOutcome[];
  severityDistribution: SeverityCounts;
  riskDistribution: RiskDistribution;
}
