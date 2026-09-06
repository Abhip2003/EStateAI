// Phase 29 (Multi-Agent Debate & Consensus) — consensus.scoring.ts's pure
// heuristics and consensus.engine.ts's assembly, exercised directly
// against fake but realistically-shaped agent outputs (no live server, no
// DB) so every branch of the deterministic corroboration/conflict logic
// is checked precisely.
import { createChecker } from './lib/verify-helpers.js';
import {
  isHighOrAboveRisk,
  classifyFindings,
  computeAgreementScore,
  deriveConflicts,
  computeConsensusConfidence,
  buildReasoningSummary,
} from '../src/ai/debate/consensus.scoring.js';
import { ConsensusEngine } from '../src/ai/debate/consensus.engine.js';
import type { RiskAgentOutput } from '../src/ai/agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../src/ai/agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../src/ai/agents/recommendation/recommendation.interface.js';
import type { RiskFindingView } from '../src/ai/agents/risk/risk.types.js';
import type { RecommendationView } from '../src/ai/agents/recommendation/recommendation.types.js';

function finding(id: string, severity: RiskFindingView['severity']): RiskFindingView {
  return {
    id,
    resourceId: `resource-${id}`,
    provider: 'github',
    ruleCode: 'PUBLIC_REPOSITORY',
    severity,
    status: 'OPEN',
    title: `finding ${id}`,
    reasoning: 'test',
    businessImpact: 'MODERATE',
    evidence: [],
    priority: 'MODERATE',
    confidence: 0.9,
    repeated: false,
    createdAt: new Date().toISOString(),
  };
}

function recommendation(findingId: string): RecommendationView {
  return {
    id: `rec-${findingId}`,
    findingId,
    title: 'fix it',
    description: 'test',
    estimatedImpact: 'test',
    priority: 'HIGH',
    status: 'OPEN',
    sourceAgents: ['risk-agent'],
    sourceFindingIds: [findingId],
    relatedCompliancePolicyCodes: [],
    confidence: 0.9,
    reasoning: 'test',
    createdAt: new Date().toISOString(),
  };
}

function riskOutput(overrides: Partial<RiskAgentOutput> = {}): RiskAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: 'asset-1',
    overallScore: 10,
    businessImpact: 'LOW',
    counts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
    findings: [],
    criticalFindings: [],
    highFindings: [],
    mediumFindings: [],
    lowFindings: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'test',
    confidenceScore: 0.9,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function complianceOutput(overrides: Partial<ComplianceAgentOutput> = {}): ComplianceAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: 'asset-1',
    complianceScore: 90,
    passCount: 9,
    failCount: 0,
    warningCount: 0,
    notApplicableCount: 0,
    policyFailures: [],
    policyPasses: [],
    frameworks: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'test',
    confidenceScore: 0.9,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function recommendationOutput(
  overrides: Partial<RecommendationAgentOutput> = {},
): RecommendationAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: 'asset-1',
    recommendations: [],
    prioritized: [],
    handoffSources: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'test',
    confidenceScore: 0.9,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function main(): void {
  const { check, state } = createChecker();

  console.log('1. isHighOrAboveRisk — business impact ranking');
  check('SEVERE is high-or-above', isHighOrAboveRisk('SEVERE'));
  check('HIGH is high-or-above', isHighOrAboveRisk('HIGH'));
  check('MODERATE is not high-or-above', !isHighOrAboveRisk('MODERATE'));
  check('LOW is not high-or-above', !isHighOrAboveRisk('LOW'));
  check('MINIMAL is not high-or-above', !isHighOrAboveRisk('MINIMAL'));

  console.log('2. classifyFindings — corroboration via Recommendation sourceFindingIds');
  const f1 = finding('f1', 'HIGH');
  const f2 = finding('f2', 'MEDIUM');
  const { accepted, rejected } = classifyFindings(
    riskOutput({ findings: [f1, f2] }),
    recommendationOutput({ recommendations: [recommendation('f1')] }),
  );
  check('f1 (cited by a recommendation) is accepted', accepted.includes('f1'));
  check('f2 (not cited) is rejected', rejected.includes('f2'));

  console.log('3. computeAgreementScore');
  check('all accepted -> agreement 1.0', computeAgreementScore(['f1', 'f2'], []) === 1);
  check('all rejected -> agreement 0.0', computeAgreementScore([], ['f1', 'f2']) === 0);
  check('half accepted -> agreement 0.5', computeAgreementScore(['f1'], ['f2']) === 0.5);
  check(
    'no findings -> agreement 1.0 (nothing to disagree about)',
    computeAgreementScore([], []) === 1,
  );

  console.log('4. deriveConflicts — every structural cross-check');
  const noConflicts = deriveConflicts(
    riskOutput({ businessImpact: 'LOW' }),
    complianceOutput({ complianceScore: 90 }),
    recommendationOutput({ recommendations: [] }),
  );
  check('low risk + high compliance + no findings -> no conflicts', noConflicts.length === 0);

  const impactVsCompliance = deriveConflicts(
    riskOutput({ businessImpact: 'SEVERE' }),
    complianceOutput({ complianceScore: 95 }),
    recommendationOutput({}),
  );
  check(
    'HIGH/SEVERE risk vs high compliance score is a conflict',
    impactVsCompliance.some(
      (c) => c.agents.includes('risk-agent') && c.agents.includes('compliance-agent'),
    ),
  );

  const unaddressedRisk = deriveConflicts(
    riskOutput({ criticalFindings: [finding('c1', 'CRITICAL')] }),
    complianceOutput({}),
    recommendationOutput({ recommendations: [] }),
  );
  check(
    'critical findings with zero recommendations is a conflict',
    unaddressedRisk.some(
      (c) => c.agents.includes('risk-agent') && c.agents.includes('recommendation-agent'),
    ),
  );

  const unaddressedCompliance = deriveConflicts(
    riskOutput({}),
    complianceOutput({ failCount: 3 }),
    recommendationOutput({ recommendations: [] }),
  );
  check(
    'compliance failures with zero recommendations is a conflict',
    unaddressedCompliance.some(
      (c) => c.agents.includes('compliance-agent') && c.agents.includes('recommendation-agent'),
    ),
  );

  const uncorroborated = deriveConflicts(
    riskOutput({ findings: [f1, f2] }),
    complianceOutput({}),
    recommendationOutput({ recommendations: [recommendation('f1')] }),
  );
  check(
    'an uncorroborated finding is its own conflict',
    uncorroborated.some((c) => c.description.includes('not corroborated')),
  );

  console.log('5. computeConsensusConfidence');
  const highConfidence = computeConsensusConfidence([0.9, 0.9, 0.9], 1);
  check(
    'high participant confidence + full agreement -> high consensus confidence',
    highConfidence > 0.85,
  );
  const lowConfidence = computeConsensusConfidence([0.3, 0.3, 0.3], 0);
  check(
    'low participant confidence + no agreement -> low consensus confidence',
    lowConfidence < 0.3,
  );
  check(
    'no confidences -> falls back to agreementScore',
    computeConsensusConfidence([], 0.42) === 0.42,
  );

  console.log('6. buildReasoningSummary — mentions assetId, agreement %, conflicts');
  const summary = buildReasoningSummary({
    assetId: 'asset-1',
    agreementScore: 0.5,
    conflicts: uncorroborated,
    accepted: ['f1'],
    rejected: ['f2'],
  });
  check('summary mentions the assetId', summary.includes('asset-1'));
  check('summary mentions the agreement percentage', summary.includes('50%'));
  check('summary mentions rejected findings', summary.includes('1 finding(s) rejected'));

  console.log('7. ConsensusEngine.compute() — full assembly');
  const engine = new ConsensusEngine();
  const report = engine.compute({
    debateId: 'debate-1',
    assetId: 'asset-1',
    risk: riskOutput({ findings: [f1, f2], businessImpact: 'HIGH' }),
    compliance: complianceOutput({ failCount: 1 }),
    recommendation: recommendationOutput({ recommendations: [recommendation('f1')] }),
    copilotConfidence: 0.8,
  });
  check('report carries the debateId', report.debateId === 'debate-1');
  check('report carries the assetId', report.assetId === 'asset-1');
  check(
    'agreementScore is between 0 and 1',
    report.agreementScore >= 0 && report.agreementScore <= 1,
  );
  check('confidence is between 0 and 1', report.confidence >= 0 && report.confidence <= 1);
  check('acceptedFindings includes f1', report.acceptedFindings.includes('f1'));
  check('rejectedFindings includes f2', report.rejectedFindings.includes('f2'));
  check('reasoningSummary is non-empty', report.reasoningSummary.length > 0);
  const secondReport = engine.compute({
    debateId: 'debate-1',
    assetId: 'asset-1',
    risk: riskOutput({ findings: [f1, f2], businessImpact: 'HIGH' }),
    compliance: complianceOutput({ failCount: 1 }),
    recommendation: recommendationOutput({ recommendations: [recommendation('f1')] }),
    copilotConfidence: 0.8,
  });
  check('consensusId is unique per call', secondReport.consensusId !== report.consensusId);

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main();
