// Phase 29 spec #2/#3 — Debate Participants & Debate Flow. Confirms
// DebateEngine.run() calls the real registered agents in the spec's exact
// order (Risk -> Recommendation critiques Risk -> Compliance critiques
// Recommendation), that every participant's own execute() is what
// actually ran (via a fake registered under each real agent id, exactly
// like every other phase's verify scripts do), and that no participant's
// output is ever mutated by the debate engine or by another participant.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import { redis } from '../src/cache/redis.js';
import { DebateEngine } from '../src/ai/debate/debate.engine.js';
import type { RiskAgentOutput } from '../src/ai/agents/risk/risk.interface.js';
import type { ComplianceAgentOutput } from '../src/ai/agents/compliance/compliance.interface.js';
import type { RecommendationAgentOutput } from '../src/ai/agents/recommendation/recommendation.interface.js';
import type { CopilotAgentOutput } from '../src/ai/agents/copilot/copilot.interface.js';

const ASSET_ID = 'verify-agent-review-asset';

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const calls: string[] = [];

  const riskOutput: RiskAgentOutput = {
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
    summary: 'low risk',
    confidenceScore: 0.95,
    warnings: [],
    errors: [],
  };
  const complianceOutput: ComplianceAgentOutput = {
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
    summary: 'compliant',
    confidenceScore: 0.95,
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
    summary: 'nothing to recommend',
    confidenceScore: 0.95,
    warnings: [],
    errors: [],
  };

  orchestratorAgentRegistry.register({
    id: 'risk-agent',
    description: 'fake for verify-agent-review',
    canHandle: () => true,
    execute: () => {
      calls.push('risk-agent');
      return Promise.resolve(riskOutput);
    },
  });
  orchestratorAgentRegistry.register({
    id: 'recommendation-agent',
    description: 'fake for verify-agent-review',
    canHandle: () => true,
    execute: () => {
      calls.push('recommendation-agent');
      return Promise.resolve(recommendationOutput);
    },
  });
  orchestratorAgentRegistry.register({
    id: 'compliance-agent',
    description: 'fake for verify-agent-review',
    canHandle: () => true,
    execute: () => {
      calls.push('compliance-agent');
      return Promise.resolve(complianceOutput);
    },
  });
  orchestratorAgentRegistry.register({
    id: 'copilot-agent',
    description: 'fake for verify-agent-review',
    canHandle: () => true,
    execute: () => {
      calls.push('copilot-agent');
      const output: CopilotAgentOutput = {
        status: 'SUCCESS',
        answer: 'no disagreements found',
        explanation: {
          summary: 's',
          reasoning: 'r',
          evidence: [],
          suggestedAction: 'a',
          confidence: 90,
        },
        intent: 'SUMMARIZE_REPORT',
        assetId: ASSET_ID,
        conversationId: 'debate-conv',
        sourceAgents: ['risk-agent', 'compliance-agent', 'recommendation-agent'],
        metadata: { startedAt: '', finishedAt: '', durationMs: 0 },
        confidenceScore: 0.9,
        warnings: [],
        errors: [],
      };
      return Promise.resolve(output);
    },
  });

  try {
    console.log('1. every participant is called exactly once, in spec order');
    const engine = new DebateEngine();
    const record = await engine.run({ assetId: ASSET_ID, user: { id: 'u1', role: 'ADMIN' } });

    check('risk-agent was called', calls.filter((id) => id === 'risk-agent').length === 1);
    check(
      'recommendation-agent was called',
      calls.filter((id) => id === 'recommendation-agent').length === 1,
    );
    check(
      'compliance-agent was called',
      calls.filter((id) => id === 'compliance-agent').length === 1,
    );
    check(
      'call order is risk -> recommendation -> compliance',
      calls.slice(0, 3).join(',') === 'risk-agent,recommendation-agent,compliance-agent',
    );

    console.log("2. DebateTurn critique labeling matches spec #3's flow");
    const [riskTurn, recommendationTurn, complianceTurn] = record.turns;
    check('risk-agent turn critiques nothing', riskTurn.critiques === undefined);
    check(
      'recommendation-agent turn critiques risk-agent',
      recommendationTurn.critiques === 'risk-agent',
    );
    check(
      'compliance-agent turn critiques recommendation-agent',
      complianceTurn.critiques === 'recommendation-agent',
    );

    console.log('3. no participant output was mutated by the debate engine');
    check(
      'risk turn output is the exact object returned by risk-agent',
      riskTurn.output === riskOutput,
    );
    check(
      'recommendation turn output is the exact object returned by recommendation-agent',
      recommendationTurn.output === recommendationOutput,
    );
    check(
      'compliance turn output is the exact object returned by compliance-agent',
      complianceTurn.output === complianceOutput,
    );

    console.log('4. low risk + high agreement -> debate does not trigger -> Copilot never called');
    check('debate did not trigger', record.triggered === false);
    check('copilot-agent was never called (not triggered)', !calls.includes('copilot-agent'));
    check('consensus is absent when not triggered', record.consensus === undefined);
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
