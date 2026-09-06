import type { IndexDocumentInput } from '../knowledge/knowledge.types.js';

// Adapters project each agent's own output shape into IndexDocumentInput
// rows for the Knowledge Store — the "Automatic Indexing" (Phase 23
// spec #4) call site. Same rationale as finding.adapters.ts: kept in
// ai/shared/ (not inside a specific agent's folder) with locally-declared
// structural types (not imported from risk.types.ts/etc.) so this module
// never creates an agent -> shared -> agent import cycle, and the single
// caller (orchestrator/executor.ts) never has to import a specific
// agent's types either.

interface RiskFindingLike {
  id: string;
  resourceId: string;
  title: string;
  reasoning: string;
  severity: string;
  evidence: string[];
  confidence: number;
  createdAt: string;
}

interface RiskOutputLike {
  assetId: string;
  overallScore: number;
  businessImpact: string;
  summary: string;
  findings: RiskFindingLike[];
  metadata: { finishedAt: string };
}

export function documentsFromRiskOutput(output: RiskOutputLike): IndexDocumentInput[] {
  const assetId = output.assetId;
  // sourceId includes finishedAt (not just assetId) so every run adds a
  // new snapshot instead of overwriting the previous one — Conversation
  // Memory / Agent Memory (spec #7-8) needs "what changed since last
  // scan?" to be answerable from KnowledgeStore.getHistory(), which only
  // works if history actually accumulates. Findings below stay
  // keyed by their stable Finding id — those map 1:1 to a live row and
  // should update in place, not accumulate duplicates.
  const overview: IndexDocumentInput = {
    assetId,
    agent: 'risk-agent',
    documentType: 'RISK_ASSESSMENT',
    text: `Risk assessment for asset ${assetId}: overall score ${output.overallScore}, business impact ${output.businessImpact}. ${output.summary}`,
    metadata: { overallScore: output.overallScore, businessImpact: output.businessImpact },
    tags: ['risk', output.businessImpact.toLowerCase()],
    sourceId: `risk-assessment:${assetId}:${output.metadata.finishedAt}`,
  };

  const findings = output.findings.map<IndexDocumentInput>((finding) => ({
    assetId,
    agent: 'risk-agent',
    documentType: 'FINDING',
    text: `${finding.title} (${finding.severity}): ${finding.reasoning}${
      finding.evidence.length > 0 ? ` Evidence: ${finding.evidence.join('; ')}` : ''
    }`,
    metadata: {
      severity: finding.severity,
      resourceId: finding.resourceId,
      confidence: finding.confidence,
    },
    tags: ['finding', finding.severity.toLowerCase()],
    sourceId: finding.id,
  }));

  return [overview, ...findings];
}

interface PolicyOutcomeLike {
  policyCode: string;
  policyName: string;
  resourceId: string;
  reason: string;
}

interface ComplianceOutputLike {
  assetId: string;
  complianceScore: number;
  summary: string;
  policyFailures: PolicyOutcomeLike[];
  metadata: { finishedAt: string };
}

export function documentsFromComplianceOutput(output: ComplianceOutputLike): IndexDocumentInput[] {
  const assetId = output.assetId;
  const overview: IndexDocumentInput = {
    assetId,
    agent: 'compliance-agent',
    documentType: 'COMPLIANCE_RESULT',
    text: `Compliance result for asset ${assetId}: score ${output.complianceScore}. ${output.summary}`,
    metadata: { complianceScore: output.complianceScore },
    tags: ['compliance'],
    sourceId: `compliance-result:${assetId}:${output.metadata.finishedAt}`,
  };

  const failures = output.policyFailures.map<IndexDocumentInput>((failure, index) => ({
    assetId,
    agent: 'compliance-agent',
    documentType: 'COMPLIANCE_RESULT',
    text: `${failure.policyName} (${failure.policyCode}) failed: ${failure.reason}`,
    metadata: { policyCode: failure.policyCode, resourceId: failure.resourceId },
    tags: ['compliance', 'failure'],
    sourceId: `compliance-failure:${assetId}:${failure.policyCode}:${index}`,
  }));

  return [overview, ...failures];
}

interface RecommendationLike {
  id: string;
  title: string;
  description: string;
  estimatedImpact: string;
  priority: string;
  reasoning: string;
}

interface RecommendationOutputLike {
  assetId: string;
  summary: string;
  recommendations: RecommendationLike[];
}

export function documentsFromRecommendationOutput(
  output: RecommendationOutputLike,
): IndexDocumentInput[] {
  const assetId = output.assetId;
  return output.recommendations.map<IndexDocumentInput>((recommendation) => ({
    assetId,
    agent: 'recommendation-agent',
    documentType: 'RECOMMENDATION',
    text: `${recommendation.title} (${recommendation.priority}): ${recommendation.description}. ${recommendation.reasoning} Estimated impact: ${recommendation.estimatedImpact}`,
    metadata: { priority: recommendation.priority },
    tags: ['recommendation', recommendation.priority.toLowerCase()],
    sourceId: recommendation.id,
  }));
}

interface ReportSectionLike {
  id: string;
  title: string;
  content: string;
}

interface ReportOutputLike {
  assetId: string;
  summary: string;
  sections: ReportSectionLike[];
  metadata: { finishedAt: string };
}

export function documentsFromReportOutput(output: ReportOutputLike): IndexDocumentInput[] {
  const assetId = output.assetId;
  const finishedAt = output.metadata.finishedAt;
  const overview: IndexDocumentInput = {
    assetId,
    agent: 'report-agent',
    documentType: 'REPORT',
    text: `Report for asset ${assetId}: ${output.summary}`,
    metadata: {},
    tags: ['report'],
    sourceId: `report:${assetId}:${finishedAt}`,
  };

  const sections = output.sections.map<IndexDocumentInput>((section) => ({
    assetId,
    agent: 'report-agent',
    documentType: 'REPORT',
    text: `${section.title}: ${section.content}`,
    metadata: { sectionId: section.id },
    tags: ['report', 'section'],
    sourceId: `report:${assetId}:${finishedAt}:${section.id}`,
  }));

  return [overview, ...sections];
}

interface DiscoveryOutputLike {
  accountId: string;
  provider: string;
  resourceCount: number;
  summary: string;
  metadata: { finishedAt: string };
}

// Discovery has no `assetId` on its own output (it's account-scoped) —
// the caller (executor.ts) resolves the asset from OrchestrationContext,
// same fallback DiscoveryAgentImpl.execute() already uses for its input.
export function documentsFromDiscoveryOutput(
  output: DiscoveryOutputLike,
  assetId: string,
): IndexDocumentInput[] {
  return [
    {
      assetId,
      agent: 'discovery-agent',
      documentType: 'DISCOVERY_SUMMARY',
      text: `Discovery summary for asset ${assetId} (${output.provider}, account ${output.accountId}): ${output.resourceCount} resources. ${output.summary}`,
      metadata: { provider: output.provider, resourceCount: output.resourceCount },
      tags: ['discovery'],
      sourceId: `discovery:${assetId}:${output.accountId}:${output.metadata.finishedAt}`,
    },
  ];
}
