export interface ConfidenceInputs {
  toolSuccessRatio: number; // 0..1
  agentConfidences: number[]; // per-step confidenceScore, where the agent exposes one
  retrievalConfidence?: number; // 0..1, average RAG document score, when retrieval ran
  criticScore: number; // 0..1, from CriticReport.score
}

// Weighted blend of four independent confidence signals. Weights are a
// documented heuristic (Critic and per-agent confidence weighted
// highest, since they're the signals most likely to catch a problem tool
// success alone would miss), not a tuned model — a future phase can
// replace this with a learned aggregator without changing the input
// shape callers already assemble.
const WEIGHTS = { tool: 0.15, agent: 0.3, retrieval: 0.2, critic: 0.35 };

// Neutral fallback used whenever a signal wasn't available for this run
// (e.g. no retrieval call was made) — deliberately not 0 or 1, so a
// missing signal doesn't swing the aggregate toward false confidence or
// false alarm.
const NEUTRAL_CONFIDENCE = 0.7;

export function aggregateConfidence(inputs: ConfidenceInputs): number {
  const agentAvg =
    inputs.agentConfidences.length === 0
      ? NEUTRAL_CONFIDENCE
      : inputs.agentConfidences.reduce((sum, value) => sum + value, 0) /
        inputs.agentConfidences.length;
  const retrieval = inputs.retrievalConfidence ?? NEUTRAL_CONFIDENCE;

  const score =
    inputs.toolSuccessRatio * WEIGHTS.tool +
    agentAvg * WEIGHTS.agent +
    retrieval * WEIGHTS.retrieval +
    inputs.criticScore * WEIGHTS.critic;

  return Math.max(0, Math.min(1, score));
}
