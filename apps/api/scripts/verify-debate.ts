// Phase 29 — Multi-Agent Debate & Consensus foundation checks: a full
// triggered debate end to end (fake agents, no live server), spec #6's
// Reflection Integration (ReflectionReport carries debateSummary/
// disagreements/consensusConfidence, readable back via the existing,
// unchanged ReflectionStore), and spec #8's telemetry actually being
// recorded.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { redis } from '../src/cache/redis.js';
import { debateEngine } from '../src/ai/debate/debate.engine.js';
import { reasoningFoundation } from '../src/ai/planner/reasoning.js';
import { metricsRegistry } from '../src/observability/metrics.js';
import type { RiskAgentOutput } from '../src/ai/agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../src/ai/agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../src/ai/agents/recommendation/recommendation.interface.js';
import type { CopilotAgentOutput } from '../src/ai/agents/copilot/copilot.interface.js';
import type { RiskFindingView } from '../src/ai/agents/risk/risk.types.js';

const ASSET_ID = 'verify-debate-asset';

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

async function main(): Promise<void> {
  const { check, state } = createChecker();

  const riskOutput: RiskAgentOutput = {
    status: 'SUCCESS',
    assetId: ASSET_ID,
    overallScore: 95,
    businessImpact: 'SEVERE',
    counts: { critical: 1, high: 0, medium: 0, low: 0, informational: 0 },
    findings: [finding('f1')],
    criticalFindings: [finding('f1')],
    highFindings: [],
    mediumFindings: [],
    lowFindings: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'severe risk',
    confidenceScore: 0.9,
    warnings: [],
    errors: [],
  };
  const complianceOutput: ComplianceAgentOutput = {
    status: 'SUCCESS',
    assetId: ASSET_ID,
    complianceScore: 40,
    passCount: 4,
    failCount: 6,
    warningCount: 0,
    notApplicableCount: 0,
    policyFailures: [],
    policyPasses: [],
    frameworks: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'non-compliant',
    confidenceScore: 0.85,
    warnings: [],
    errors: [],
  };
  const recommendationOutput: RecommendationAgentOutput = {
    status: 'SUCCESS',
    assetId: ASSET_ID,
    recommendations: [],
    prioritized: [],
    handoffSources: [],
    metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
    summary: 'nothing recommended yet',
    confidenceScore: 0.8,
    warnings: [],
    errors: [],
  };

  orchestratorAgentRegistry.register({
    id: 'risk-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(riskOutput),
  });
  orchestratorAgentRegistry.register({
    id: 'recommendation-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(recommendationOutput),
  });
  orchestratorAgentRegistry.register({
    id: 'compliance-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => Promise.resolve(complianceOutput),
  });
  orchestratorAgentRegistry.register({
    id: 'copilot-agent',
    description: 'fake',
    canHandle: () => true,
    execute: () => {
      const output: CopilotAgentOutput = {
        status: 'SUCCESS',
        answer:
          'Risk reports severe impact while compliance shows many failures; no recommendations exist yet.',
        explanation: {
          summary: 's',
          reasoning: 'r',
          evidence: [],
          suggestedAction: 'a',
          confidence: 75,
        },
        intent: 'SUMMARIZE_REPORT',
        assetId: ASSET_ID,
        conversationId: 'debate-conv',
        sourceAgents: ['risk-agent', 'compliance-agent', 'recommendation-agent'],
        metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
        confidenceScore: 0.75,
        warnings: [],
        errors: [],
      };
      return Promise.resolve(output);
    },
  });

  try {
    console.log('1. full triggered debate end to end');
    const record = await debateEngine.run({ assetId: ASSET_ID, user: { id: 'u1', role: 'ADMIN' } });
    check('debate triggered', record.triggered === true);
    check(
      '4 turns recorded (Risk, Recommendation, Compliance, Copilot)',
      record.turns.length === 4,
    );
    check(
      'turn order matches spec #3',
      record.turns.map((t) => t.agentId).join(',') ===
        'risk-agent,recommendation-agent,compliance-agent,copilot-agent',
    );
    check('consensus was computed', record.consensus !== undefined);
    check('consensus links back to this debate', record.consensus?.debateId === record.debateId);
    check('durationMs is recorded and non-negative', record.durationMs >= 0);

    console.log(
      '2. Reflection Integration (spec #6) — via the existing, unchanged ReflectionStore',
    );
    const reflection = await reasoningFoundation.reflectionStore.get(record.debateId);
    check('a reflection was persisted for this debate', reflection !== undefined);
    check(
      "reflection.debateSummary matches Copilot's answer",
      reflection?.debateSummary ===
        'Risk reports severe impact while compliance shows many failures; no recommendations exist yet.',
    );
    check(
      "reflection.disagreements matches the consensus report's conflicts",
      reflection?.disagreements?.length === record.consensus?.conflicts.length,
    );
    check(
      "reflection.consensusConfidence matches the consensus report's confidence",
      reflection?.consensusConfidence === record.consensus?.confidence,
    );
    check(
      'reflection.overallConfidence is still populated (pre-existing field, unaffected)',
      typeof reflection?.overallConfidence === 'number',
    );

    console.log('3. Telemetry (spec #8) — estateai_ai_debate_* metrics recorded');
    const metricsText = await metricsRegistry.metrics();
    check(
      'estateai_ai_debate_runs_total is registered',
      metricsText.includes('estateai_ai_debate_runs_total'),
    );
    check(
      'estateai_ai_debate_duration_seconds is registered',
      metricsText.includes('estateai_ai_debate_duration_seconds'),
    );
    check(
      'estateai_ai_debate_participants is registered',
      metricsText.includes('estateai_ai_debate_participants'),
    );
    check(
      'estateai_ai_debate_messages_total is registered',
      metricsText.includes('estateai_ai_debate_messages_total'),
    );
    check(
      'estateai_ai_debate_agreement_percent is registered',
      metricsText.includes('estateai_ai_debate_agreement_percent'),
    );
    check(
      'estateai_ai_debate_confidence_delta is registered',
      metricsText.includes('estateai_ai_debate_confidence_delta'),
    );
  } finally {
    orchestratorAgentRegistry.unregister('risk-agent');
    orchestratorAgentRegistry.unregister('recommendation-agent');
    orchestratorAgentRegistry.unregister('compliance-agent');
    orchestratorAgentRegistry.unregister('copilot-agent');
  }

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
