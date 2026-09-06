import type { GraphState } from './state.js';

// Conditional routing (spec #5) — reads values Discovery/Risk Agents
// already produced, never recomputes anything itself (same "read, don't
// recalculate" rule every concrete agent in this codebase already
// follows for scores it reports).
export const RISK_SCORE_THRESHOLD = 50; // 0-100 scale, per RiskService's RiskScore.overallScore

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function hasDiscoveredResources(state: GraphState): boolean {
  const discovery = asRecord(state.discovery);
  if (!discovery) return false;
  const resourceCount = discovery.resourceCount;
  if (typeof resourceCount === 'number') return resourceCount > 0;
  const resources = discovery.resources;
  return Array.isArray(resources) && resources.length > 0;
}

export function riskScoreExceedsThreshold(state: GraphState): boolean {
  const risk = asRecord(state.risk);
  const overallScore = risk?.overallScore;
  return typeof overallScore === 'number' && overallScore > RISK_SCORE_THRESHOLD;
}
