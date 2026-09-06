// Phase 30 spec #7 — Confidence Calibration, and spec #5's Tool Selection
// aggregation. Pure unit tests of episode.relevance.ts against hand-built
// Episode fixtures — no server/DB/Redis needed, same style as Phase 29's
// verify-consensus.ts.
import {
  calibrateConfidence,
  computeAgentReliability,
  computeToolReliability,
} from '../src/ai/episodic-memory/episode.relevance.js';
import type { Episode } from '../src/ai/episodic-memory/episode.types.js';
import { createChecker } from './lib/verify-helpers.js';

function episode(overrides: Partial<Episode>): Episode {
  return {
    episodeId: `ep-${Math.random().toString(36).slice(2)}`,
    executionId: 'exec',
    goal: 'goal',
    workflowId: 'workflow',
    agentsInvolved: ['risk-agent'],
    toolUsage: [],
    disagreements: [],
    durationMs: 100,
    failedSteps: [],
    retryCount: 0,
    approvalEvents: [],
    outcome: 'COMPLETED',
    confidence: 0.8,
    lessons: { whatWorked: [], whatFailed: [], lessonsLearned: [], futureSuggestions: [] },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function main(): void {
  const { check, state } = createChecker();

  console.log('1. calibrateConfidence — base only (no history) returns the base confidence');
  check(
    'no-history calibration equals base',
    Math.abs(calibrateConfidence({ baseConfidence: 0.7 }) - 0.7) < 1e-9,
  );

  console.log('2. calibrateConfidence — strong history pulls confidence up');
  const boosted = calibrateConfidence({
    baseConfidence: 0.5,
    historicalSuccessRate: 1.0,
    similarityScore: 0.95,
    agentReliability: 1.0,
    toolReliability: 1.0,
  });
  check('strong positive history raises confidence above base', boosted > 0.5, `${boosted}`);

  console.log('3. calibrateConfidence — weak history pulls confidence down');
  const dragged = calibrateConfidence({
    baseConfidence: 0.8,
    historicalSuccessRate: 0.1,
    similarityScore: 0.9,
  });
  check('weak historical success rate lowers confidence below base', dragged < 0.8, `${dragged}`);

  console.log('4. calibrateConfidence — always clamped to [0,1]');
  const clampedHigh = calibrateConfidence({
    baseConfidence: 1,
    historicalSuccessRate: 1,
    similarityScore: 1,
    agentReliability: 1,
    toolReliability: 1,
  });
  check('never exceeds 1', clampedHigh <= 1, `${clampedHigh}`);

  console.log('5. computeAgentReliability — success rate and average confidence over episodes');
  const episodes: Episode[] = [
    episode({ agentsInvolved: ['risk-agent'], failedSteps: [], confidence: 0.9 }),
    episode({ agentsInvolved: ['risk-agent'], failedSteps: ['risk-agent'], confidence: 0.3 }),
    episode({ agentsInvolved: ['compliance-agent'], failedSteps: [], confidence: 0.7 }),
  ];
  const agentStats = computeAgentReliability(episodes);
  const riskStats = agentStats.find((s) => s.agentId === 'risk-agent');
  check('risk-agent ran twice', riskStats?.totalRuns === 2);
  check('risk-agent succeeded once', riskStats?.successRuns === 1);
  check('risk-agent success rate is 0.5', riskStats?.successRate === 0.5);
  check(
    'risk-agent average confidence is (0.9+0.3)/2',
    Math.abs((riskStats?.averageConfidence ?? 0) - 0.6) < 1e-9,
  );

  console.log('6. computeToolReliability — success rate and average latency from tool usage');
  const toolEpisodes: Episode[] = [
    episode({ toolUsage: [{ toolName: 'github_issues', success: true, durationMs: 100 }] }),
    episode({ toolUsage: [{ toolName: 'github_issues', success: false, durationMs: 300 }] }),
    episode({ toolUsage: [{ toolName: 'github_issues', success: true, durationMs: 200 }] }),
  ];
  const toolStats = computeToolReliability(toolEpisodes);
  const githubStats = toolStats.find((s) => s.toolName === 'github_issues');
  check('github_issues ran 3 times', githubStats?.totalRuns === 3);
  check('github_issues succeeded twice', githubStats?.successRuns === 2);
  check(
    'github_issues success rate is 2/3',
    Math.abs((githubStats?.successRate ?? 0) - 2 / 3) < 1e-9,
  );
  check(
    'github_issues average latency is (100+300+200)/3',
    Math.abs((githubStats?.averageLatencyMs ?? 0) - 200) < 1e-9,
  );

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
