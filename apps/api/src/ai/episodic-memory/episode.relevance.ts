import type {
  AgentReliability,
  ConfidenceCalibrationInput,
  Episode,
  ToolReliability,
} from './episode.types.js';

// Tool Selection (spec #5) — aggregates successful/failed tool usage,
// average latency, and success rate straight out of already-stored
// episodes. Exposed as a plain function over `Episode[]` rather than
// wired into copilot.tool-selector.ts's regex-based selectTool()
// directly, since that selector is stateless-by-design and owned by the
// Copilot agent (Phase 29's "do not modify existing agents" precedent);
// any future caller (planner, a smarter tool selector) can call this
// without this module reaching into agent code.
export function computeToolReliability(episodes: Episode[]): ToolReliability[] {
  const byTool = new Map<
    string,
    { total: number; success: number; latencySum: number; latencyCount: number }
  >();
  for (const episode of episodes) {
    for (const usage of episode.toolUsage) {
      const entry = byTool.get(usage.toolName) ?? {
        total: 0,
        success: 0,
        latencySum: 0,
        latencyCount: 0,
      };
      entry.total += 1;
      if (usage.success) entry.success += 1;
      if (typeof usage.durationMs === 'number') {
        entry.latencySum += usage.durationMs;
        entry.latencyCount += 1;
      }
      byTool.set(usage.toolName, entry);
    }
  }
  return Array.from(byTool.entries()).map(([toolName, entry]) => ({
    toolName,
    totalRuns: entry.total,
    successRuns: entry.success,
    successRate: entry.total > 0 ? entry.success / entry.total : 0,
    averageLatencyMs: entry.latencyCount > 0 ? entry.latencySum / entry.latencyCount : 0,
  }));
}

// Confidence Calibration (spec #7) — same shape of aggregation, keyed by
// agent instead of tool, reusing `Episode.agentsInvolved` +
// `Episode.failedSteps` + `Episode.confidence` (the whole-execution
// confidence; per-agent confidence isn't retained on the episode, so
// "averageConfidence" here is the average of the *episode's* overall
// confidence across episodes that agent participated in — a coarser but
// honest signal, not a fabricated per-agent score).
export function computeAgentReliability(episodes: Episode[]): AgentReliability[] {
  const byAgent = new Map<string, { total: number; success: number; confidenceSum: number }>();
  for (const episode of episodes) {
    for (const agentId of episode.agentsInvolved) {
      const entry = byAgent.get(agentId) ?? { total: 0, success: 0, confidenceSum: 0 };
      entry.total += 1;
      if (!episode.failedSteps.includes(agentId)) entry.success += 1;
      entry.confidenceSum += episode.confidence;
      byAgent.set(agentId, entry);
    }
  }
  return Array.from(byAgent.entries()).map(([agentId, entry]) => ({
    agentId,
    totalRuns: entry.total,
    successRuns: entry.success,
    successRate: entry.total > 0 ? entry.success / entry.total : 0,
    averageConfidence: entry.total > 0 ? entry.confidenceSum / entry.total : 0,
  }));
}

const WEIGHTS = {
  base: 0.4,
  historicalSuccessRate: 0.25,
  similarityScore: 0.15,
  agentReliability: 0.1,
  toolReliability: 0.1,
};

// Confidence Calibration (spec #7) — a weighted blend of the planner's
// own base confidence with historical signals, clamped to [0,1]. Any
// signal the caller doesn't have (e.g. no similar episodes found) is
// simply omitted from the weighted sum and its weight is redistributed
// proportionally across the signals that *are* present, so calibration
// degrades gracefully to the base confidence when no history exists.
export function calibrateConfidence(input: ConfidenceCalibrationInput): number {
  const parts: Array<{ value: number; weight: number }> = [
    { value: input.baseConfidence, weight: WEIGHTS.base },
  ];
  if (typeof input.historicalSuccessRate === 'number') {
    parts.push({ value: input.historicalSuccessRate, weight: WEIGHTS.historicalSuccessRate });
  }
  if (typeof input.similarityScore === 'number') {
    parts.push({ value: input.similarityScore, weight: WEIGHTS.similarityScore });
  }
  if (typeof input.agentReliability === 'number') {
    parts.push({ value: input.agentReliability, weight: WEIGHTS.agentReliability });
  }
  if (typeof input.toolReliability === 'number') {
    parts.push({ value: input.toolReliability, weight: WEIGHTS.toolReliability });
  }
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const weighted = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  const calibrated = totalWeight > 0 ? weighted / totalWeight : input.baseConfidence;
  return Math.min(1, Math.max(0, calibrated));
}
