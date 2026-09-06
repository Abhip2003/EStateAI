import type { Finding } from './finding.types.js';

// Adapters project each agent's own output shape into the shared Finding
// format, at handoff time only — Risk/Compliance Agents keep returning
// their own richer output types (RiskAgentOutput/ComplianceAgentOutput)
// unchanged; nothing here is persisted or replaces those types. Kept in
// ai/shared/ rather than inside ai/agents/recommendation/ so any future
// consumer (Report Agent, a future Copilot Agent) can reuse the same
// adapters without depending on the Recommendation Agent module.

// Structural subset of RiskAgentOutput.findings (RiskFindingView) — kept
// local instead of importing risk.types.ts, so this shared module never
// depends on a specific agent's package (avoids a shared -> agent ->
// shared import cycle risk as more agents are added).
interface RiskFindingViewLike {
  id: string;
  resourceId: string;
  ruleCode: string;
  severity: string;
  title: string;
  reasoning: string;
  evidence: string[];
  confidence: number;
  createdAt: string;
}

export function findingsFromRiskOutput(findings: RiskFindingViewLike[]): Finding[] {
  return findings.map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity as Finding['severity'],
    category: 'RISK',
    description: f.reasoning,
    resourceId: f.resourceId,
    evidence: f.evidence,
    confidence: f.confidence,
    agent: 'risk-agent',
    timestamp: f.createdAt,
    sourceCode: f.ruleCode,
  }));
}

// Structural subset of PolicyOutcomeView (compliance.types.ts) — policy
// failures carry no severity of their own (PolicyResult/Policy have
// none), so every compliance-derived Finding is normalized to MEDIUM, a
// documented, deliberate simplification rather than inventing a severity
// scale that doesn't exist in the underlying Policy model.
interface PolicyOutcomeViewLike {
  policyCode: string;
  policyName: string;
  resourceId: string;
  reason: string;
}

const COMPLIANCE_FINDING_SEVERITY: Finding['severity'] = 'MEDIUM';

export function findingsFromComplianceOutput(
  policyFailures: PolicyOutcomeViewLike[],
  assetId: string,
): Finding[] {
  return policyFailures.map((f, index) => ({
    id: `compliance:${assetId}:${f.policyCode}:${index}`,
    title: f.policyName,
    severity: COMPLIANCE_FINDING_SEVERITY,
    category: 'COMPLIANCE',
    description: f.reason,
    resourceId: f.resourceId,
    evidence: [f.reason],
    confidence: 100,
    agent: 'compliance-agent',
    timestamp: new Date().toISOString(),
    sourceCode: f.policyCode,
  }));
}

// Discovery Agent produces an inventory (resources), not an evaluation —
// it never raises a Finding. Exists so callers can loop over every
// upstream agent id uniformly without special-casing 'discovery-agent'.
export function findingsFromDiscoveryOutput(): Finding[] {
  return [];
}
