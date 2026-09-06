// Phase 27 spec #5 — Conditional Edges. Two layers: (1) the pure routing
// predicates in edges.ts against synthetic Discovery/Risk outputs, and
// (2) the real, compiled `security-conditional` graph
// (graph-builder.ts's buildConditionalGraph) run end-to-end with fake
// agents standing in for Discovery/Risk/Compliance/Recommendation/Report,
// asserting the executionTrace shows exactly the steps each branch
// should visit — nothing recomputed, only routed.
import { createChecker } from './lib/verify-helpers.js';
import { orchestratorAgentRegistry } from '../src/ai/orchestrator/agent-registry.js';
import {
  hasDiscoveredResources,
  riskScoreExceedsThreshold,
  RISK_SCORE_THRESHOLD,
} from '../src/ai/langgraph/edges.js';
import { CONDITIONAL_GRAPH_ID } from '../src/ai/langgraph/graph-builder.js';
import { graphExecutor } from '../src/ai/langgraph/executor.js';
import { graphRegistry } from '../src/ai/langgraph/graph.js';
import type { GraphState } from '../src/ai/langgraph/state.js';
import { emptyApprovalState } from '../src/ai/langgraph/state.js';
import { redis } from '../src/cache/redis.js';

function baseState(overrides: Partial<GraphState>): GraphState {
  return {
    goal: '',
    intent: '',
    messages: [],
    asset: [],
    connectedAccounts: [],
    discovery: undefined,
    risk: undefined,
    compliance: undefined,
    recommendations: undefined,
    report: undefined,
    knowledge: [],
    memory: { conversationTurns: [], session: {} },
    toolResults: [],
    reflection: undefined,
    approval: emptyApprovalState(),
    executionTrace: [],
    metadata: {},
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { check, state } = createChecker();

  console.log('1. hasDiscoveredResources() — pure predicate');
  check('false when discovery is undefined', !hasDiscoveredResources(baseState({})));
  check(
    'false when resourceCount is 0',
    !hasDiscoveredResources(baseState({ discovery: { resourceCount: 0 } })),
  );
  check(
    'true when resourceCount > 0',
    hasDiscoveredResources(baseState({ discovery: { resourceCount: 3 } })),
  );
  check(
    'true when resources array is non-empty (no resourceCount field)',
    hasDiscoveredResources(baseState({ discovery: { resources: [{ id: '1' }] } })),
  );

  console.log('2. riskScoreExceedsThreshold() — pure predicate');
  check(
    `false at exactly the threshold (${RISK_SCORE_THRESHOLD})`,
    !riskScoreExceedsThreshold(baseState({ risk: { overallScore: RISK_SCORE_THRESHOLD } })),
  );
  check(
    'true above the threshold',
    riskScoreExceedsThreshold(baseState({ risk: { overallScore: RISK_SCORE_THRESHOLD + 1 } })),
  );
  check('false when risk is undefined', !riskScoreExceedsThreshold(baseState({})));

  const AGENT_DISCOVERY = 'discovery-agent';
  const AGENT_RISK = 'risk-agent';
  const AGENT_COMPLIANCE = 'compliance-agent';
  const AGENT_RECOMMENDATION = 'recommendation-agent';
  const AGENT_REPORT = 'report-agent';

  let discoveryOutput: unknown = { resourceCount: 0, resources: [] };
  let riskOutput: unknown = { overallScore: 0 };
  const calls = { discovery: 0, risk: 0, compliance: 0, recommendation: 0, report: 0 };

  // This script runs standalone (via tsx), so none of the real
  // Discovery/Risk/.../Report agent modules have self-registered under
  // orchestratorAgentRegistry (that only happens as a side effect of
  // importing their composition-root index.ts, normally triggered by
  // server.ts's route registrations) — buildConditionalGraph()'s nodes
  // are wired to these exact agent ids, though, so registering
  // deterministic stubs under the same ids is what lets this script
  // exercise the *real* compiled conditional graph end-to-end.
  function install(): void {
    orchestratorAgentRegistry.register({
      id: AGENT_DISCOVERY,
      description: 'stub',
      canHandle: () => true,
      execute: () => {
        calls.discovery += 1;
        return Promise.resolve(discoveryOutput);
      },
    });
    orchestratorAgentRegistry.register({
      id: AGENT_RISK,
      description: 'stub',
      canHandle: () => true,
      execute: () => {
        calls.risk += 1;
        return Promise.resolve(riskOutput);
      },
    });
    orchestratorAgentRegistry.register({
      id: AGENT_COMPLIANCE,
      description: 'stub',
      canHandle: () => true,
      execute: () => {
        calls.compliance += 1;
        return Promise.resolve({ complianceScore: 1 });
      },
    });
    orchestratorAgentRegistry.register({
      id: AGENT_RECOMMENDATION,
      description: 'stub',
      canHandle: () => true,
      execute: () => {
        calls.recommendation += 1;
        return Promise.resolve({ recommendations: [] });
      },
    });
    orchestratorAgentRegistry.register({
      id: AGENT_REPORT,
      description: 'stub',
      canHandle: () => true,
      execute: () => {
        calls.report += 1;
        return Promise.resolve({ summary: 'ok', sections: [] });
      },
    });
  }

  function restore(): void {
    for (const id of [
      AGENT_DISCOVERY,
      AGENT_RISK,
      AGENT_COMPLIANCE,
      AGENT_RECOMMENDATION,
      AGENT_REPORT,
    ]) {
      orchestratorAgentRegistry.unregister(id);
    }
    graphRegistry.invalidate(CONDITIONAL_GRAPH_ID);
  }

  try {
    install();

    console.log(
      '3. no resources discovered -> routes straight to report, skipping risk/compliance/recommendation',
    );
    discoveryOutput = { resourceCount: 0, resources: [] };
    const skipRun = await graphExecutor.run({
      goal: 'run the full conditional analysis',
      user: { id: 'u1', role: 'ADMIN' },
    });
    check('graph resolved to the conditional demo graph', skipRun.graphId === CONDITIONAL_GRAPH_ID);
    const skipSteps = skipRun.state.executionTrace.map((entry) => entry.stepId);
    check('discovery ran', skipSteps.includes('discovery'));
    check('risk did NOT run', !skipSteps.includes('risk'));
    check('compliance did NOT run', !skipSteps.includes('compliance'));
    check('recommendation did NOT run', !skipSteps.includes('recommendation'));
    check('report ran', skipSteps.includes('report'));
    check('risk-agent was never invoked', calls.risk === 0);

    console.log(
      '4. resources discovered, risk score at/below threshold -> risk runs, compliance skipped',
    );
    discoveryOutput = { resourceCount: 5, resources: [{ id: '1' }] };
    riskOutput = { overallScore: RISK_SCORE_THRESHOLD - 10 };
    const lowRiskRun = await graphExecutor.run({
      goal: 'run the full conditional analysis',
      user: { id: 'u2', role: 'ADMIN' },
    });
    const lowRiskSteps = lowRiskRun.state.executionTrace.map((entry) => entry.stepId);
    check('risk ran', lowRiskSteps.includes('risk'));
    check('compliance did NOT run (score below threshold)', !lowRiskSteps.includes('compliance'));
    check('recommendation ran directly from risk', lowRiskSteps.includes('recommendation'));
    check('report ran', lowRiskSteps.includes('report'));

    console.log('5. resources discovered, risk score above threshold -> compliance runs too');
    discoveryOutput = { resourceCount: 5, resources: [{ id: '1' }] };
    riskOutput = { overallScore: RISK_SCORE_THRESHOLD + 10 };
    const highRiskRun = await graphExecutor.run({
      goal: 'run the full conditional analysis',
      user: { id: 'u3', role: 'ADMIN' },
    });
    const highRiskSteps = highRiskRun.state.executionTrace.map((entry) => entry.stepId);
    check('risk ran', highRiskSteps.includes('risk'));
    check('compliance ran (score above threshold)', highRiskSteps.includes('compliance'));
    check('recommendation ran after compliance', highRiskSteps.includes('recommendation'));
    check('report ran', highRiskSteps.includes('report'));
  } finally {
    restore();
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
