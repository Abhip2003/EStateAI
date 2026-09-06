// Phase 29 spec #5 — Trigger Conditions. Debate must automatically run
// its full flow (Copilot summarization + Consensus Engine) when overall
// confidence < threshold, OR multiple agents disagree, OR risk >= HIGH —
// and must NOT otherwise ("execution continues normally" — the three
// analytical agents still ran, but nothing further). Each of the three
// trigger reasons is exercised independently so a bug in one doesn't mask
// another.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { redis } from '../src/cache/redis.js';
import { DebateEngine } from '../src/ai/debate/debate.engine.js';
import type { RiskAgentOutput } from '../src/ai/agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../src/ai/agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../src/ai/agents/recommendation/recommendation.interface.js';
import type { CopilotAgentOutput } from '../src/ai/agents/copilot/copilot.interface.js';
import type { RiskFindingView } from '../src/ai/agents/risk/risk.types.js';

const ASSET_ID = 'verify-disagreement-asset';

function finding(id: string): RiskFindingView {
  return {
    id,
    resourceId: `resource-${id}`,
    provider: 'github',
    ruleCode: 'PUBLIC_REPOSITORY',
    severity: 'CRITICAL',
    status: 'OPEN',
    title: `finding ${id}`,
    reasoning: 'test',
    businessImpact: 'SEVERE',
    evidence: [],
    priority: 'SEVERE',
    confidence: 0.9,
    repeated: false,
    createdAt: new Date().toISOString(),
  };
}

function baseRisk(overrides: Partial<RiskAgentOutput> = {}): RiskAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: ASSET_ID,
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

function baseCompliance(overrides: Partial<ComplianceAgentOutput> = {}): ComplianceAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: ASSET_ID,
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

function baseRecommendation(
  overrides: Partial<RecommendationAgentOutput> = {},
): RecommendationAgentOutput {
  return {
    status: 'SUCCESS',
    assetId: ASSET_ID,
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

async function runScenario(
  risk: RiskAgentOutput,
  compliance: ComplianceAgentOutput,
  recommendation: RecommendationAgentOutput,
) {
  let copilotCalls = 0;
  orchestratorAgentRegistry.register({
    id: 'risk-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(risk),
  });
  orchestratorAgentRegistry.register({
    id: 'recommendation-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(recommendation),
  });
  orchestratorAgentRegistry.register({
    id: 'compliance-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(compliance),
  });
  orchestratorAgentRegistry.register({
    id: 'copilot-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => {
      copilotCalls += 1;
      const output: CopilotAgentOutput = {
        status: 'SUCCESS',
        answer: 'summary of disagreements',
        explanation: {
          summary: 's',
          reasoning: 'r',
          evidence: [],
          suggestedAction: 'a',
          confidence: 80,
        },
        intent: 'SUMMARIZE_REPORT',
        assetId: ASSET_ID,
        conversationId: 'debate-conv',
        sourceAgents: [],
        metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
        confidenceScore: 0.8,
        warnings: [],
        errors: [],
      };
      return Promise.resolve(output);
    },
  });

  try {
    const engine = new DebateEngine();
    const record = await engine.run({ assetId: ASSET_ID, user: { id: 'u1', role: 'ADMIN' } });
    return { record, copilotCalls };
  } finally {
    orchestratorAgentRegistry.unregister('risk-agent');
    orchestratorAgentRegistry.unregister('recommendation-agent');
    orchestratorAgentRegistry.unregister('compliance-agent');
    orchestratorAgentRegistry.unregister('copilot-agent');
  }
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. no trigger — low risk, high confidence, no conflicts');
  const clean = await runScenario(baseRisk(), baseCompliance(), baseRecommendation());
  check('debate not triggered', clean.record.triggered === false);
  check('no trigger reasons', clean.record.triggerReasons.length === 0);
  check('Copilot never called', clean.copilotCalls === 0);
  check('consensus absent', clean.record.consensus === undefined);

  console.log('2. HIGH_RISK trigger — risk businessImpact SEVERE');
  const highRisk = await runScenario(
    baseRisk({ businessImpact: 'SEVERE', overallScore: 95 }),
    baseCompliance(),
    baseRecommendation(),
  );
  check('debate triggered', highRisk.record.triggered === true);
  check('HIGH_RISK reason present', highRisk.record.triggerReasons.includes('HIGH_RISK'));
  check('Copilot was called', highRisk.copilotCalls === 1);
  check('consensus present', highRisk.record.consensus !== undefined);

  console.log('3. LOW_CONFIDENCE trigger — all three agents report low confidence');
  const lowConfidence = await runScenario(
    baseRisk({ confidenceScore: 0.2 }),
    baseCompliance({ confidenceScore: 0.2 }),
    baseRecommendation({ confidenceScore: 0.2 }),
  );
  check('debate triggered', lowConfidence.record.triggered === true);
  check(
    'LOW_CONFIDENCE reason present',
    lowConfidence.record.triggerReasons.includes('LOW_CONFIDENCE'),
  );
  check('Copilot was called', lowConfidence.copilotCalls === 1);

  console.log('4. DISAGREEMENT trigger — critical findings but zero recommendations');
  const disagreement = await runScenario(
    baseRisk({ criticalFindings: [finding('c1')], findings: [finding('c1')] }),
    baseCompliance(),
    baseRecommendation({ recommendations: [] }),
  );
  check('debate triggered', disagreement.record.triggered === true);
  check('DISAGREEMENT reason present', disagreement.record.triggerReasons.includes('DISAGREEMENT'));
  check('Copilot was called', disagreement.copilotCalls === 1);
  check(
    'consensus reflects the uncorroborated finding as rejected',
    disagreement.record.consensus?.rejectedFindings.includes('c1'),
  );
  check(
    'consensus reports at least one conflict',
    (disagreement.record.consensus?.conflicts.length ?? 0) > 0,
  );

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    redis.quit().catch(() => undefined);
  });
