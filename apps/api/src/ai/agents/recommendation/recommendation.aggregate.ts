import type { OrchestrationContext } from '../../orchestrator/execution.context.js';
import {
  findingsFromRiskOutput,
  findingsFromComplianceOutput,
} from '../../shared/finding.adapters.js';
import type { Finding } from '../../shared/finding.types.js';
import type {
  RecommendationHandoffSource,
  RecommendationView,
  RecommendationPriority,
} from './recommendation.types.js';

export interface RecommendationEngineRow {
  id: string;
  findingId: string;
  title: string;
  description: string;
  estimatedImpact: string;
  priority: RecommendationPriority;
  status: 'OPEN' | 'RESOLVED';
  createdAt: string;
}

// Phase 20 goal #3 (Agent Memory / cross-agent reads) — pulls the most
// recent SUCCESSful risk-agent/compliance-agent step out of
// OrchestrationContext.agentOutputs (populated by Executor between DAG
// waves, see executor.ts) and adapts each into the shared Finding shape.
// Returns undefined for a source that never ran or didn't succeed in
// this workflow — the executor decides what to do about that (fall back
// to a tool call, or mark it unavailable), this function only reads.
export function resolveHandoffFromContext(
  orchestrationContext: OrchestrationContext,
  assetId: string,
): { riskFindings?: Finding[]; complianceFindings?: Finding[] } {
  const riskEntry = [...orchestrationContext.agentOutputs]
    .reverse()
    .find((e) => e.agentId === 'risk-agent' && e.status === 'SUCCESS');
  const complianceEntry = [...orchestrationContext.agentOutputs]
    .reverse()
    .find((e) => e.agentId === 'compliance-agent' && e.status === 'SUCCESS');

  let riskFindings: Finding[] | undefined;
  if (riskEntry?.output && typeof riskEntry.output === 'object' && 'findings' in riskEntry.output) {
    const findings = (riskEntry.output as { findings: unknown[] }).findings;
    riskFindings = findingsFromRiskOutput(findings as Parameters<typeof findingsFromRiskOutput>[0]);
  }

  let complianceFindings: Finding[] | undefined;
  if (
    complianceEntry?.output &&
    typeof complianceEntry.output === 'object' &&
    'policyFailures' in complianceEntry.output
  ) {
    const policyFailures = (complianceEntry.output as { policyFailures: unknown[] }).policyFailures;
    complianceFindings = findingsFromComplianceOutput(
      policyFailures as Parameters<typeof findingsFromComplianceOutput>[0],
      assetId,
    );
  }

  return { riskFindings, complianceFindings };
}

// Phase 20 goal #9 — combines confidence across every source Finding
// backing one recommendation. A recommendation with no located source
// finding (the fallback FindingLookupTool path found the Recommendation
// row but couldn't match it back to a specific Finding) gets a moderate
// default rather than 0 (the recommendation is still a real, persisted
// row) or 100 (nothing corroborates it). Multiple independent agents
// agreeing on the same resource nudges confidence up, capped at 100.
export function aggregateConfidence(findings: Finding[]): number {
  if (findings.length === 0) {
    return 80;
  }
  const avg = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
  const distinctAgents = new Set(findings.map((f) => f.agent)).size;
  const corroborationBonus = distinctAgents > 1 ? 5 : 0;
  return Math.min(100, Math.round(avg + corroborationBonus));
}

// Phase 20 goals #5 (aggregation) and #6 (cross-agent references) —
// merges the existing, persisted Recommendation rows with the Finding(s)
// that back them. Compliance findings have no direct foreign key to a
// Recommendation (they come from PolicyResult, a different table than
// Finding), so cross-referencing them is done by resourceId: a
// compliance Finding sharing a resourceId with the recommendation's
// source risk Finding is surfaced as a related policy code, exactly
// mirroring the spec's S3-bucket example (a risk finding and a
// compliance failure on the same resource compound into one
// recommendation).
export function mergeRecommendations(
  rows: RecommendationEngineRow[],
  riskFindings: Finding[],
  complianceFindings: Finding[],
): RecommendationView[] {
  const riskByFindingId = new Map(riskFindings.map((f) => [f.id, f]));
  const complianceByResource = new Map<string, Finding[]>();
  for (const cf of complianceFindings) {
    if (!cf.resourceId) continue;
    const list = complianceByResource.get(cf.resourceId) ?? [];
    list.push(cf);
    complianceByResource.set(cf.resourceId, list);
  }

  return rows.map((row) => {
    const sourceFinding = riskByFindingId.get(row.findingId);
    const relatedCompliance = sourceFinding?.resourceId
      ? (complianceByResource.get(sourceFinding.resourceId) ?? [])
      : [];
    const sourceFindings = sourceFinding ? [sourceFinding] : [];
    const confidence = aggregateConfidence([...sourceFindings, ...relatedCompliance]);
    const sourceAgents = [
      ...(sourceFinding ? [sourceFinding.agent] : []),
      ...(relatedCompliance.length > 0 ? ['compliance-agent'] : []),
    ];

    const reasoning =
      relatedCompliance.length > 0
        ? `${row.title} — also flagged by the Compliance Agent (${relatedCompliance
            .map((c) => c.sourceCode)
            .filter(Boolean)
            .join(', ')}) on the same resource.`
        : `${row.title} — derived from a Risk Agent finding.`;

    return {
      id: row.id,
      findingId: row.findingId,
      title: row.title,
      description: row.description,
      estimatedImpact: row.estimatedImpact,
      priority: row.priority,
      status: row.status,
      sourceAgents,
      sourceFindingIds: sourceFindings.map((f) => f.id),
      relatedCompliancePolicyCodes: relatedCompliance
        .map((c) => c.sourceCode)
        .filter((code): code is string => Boolean(code)),
      confidence,
      reasoning,
      createdAt: row.createdAt,
    };
  });
}

const PRIORITY_RANK: Record<RecommendationPriority, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFORMATIONAL: 1,
};

export function prioritizeRecommendations(
  recommendations: RecommendationView[],
): RecommendationView[] {
  return [...recommendations].sort(
    (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.confidence - a.confidence,
  );
}

export function handoffSource(
  agentId: RecommendationHandoffSource['agentId'],
  findings: Finding[] | undefined,
  fallbackAvailable: boolean,
): RecommendationHandoffSource {
  if (findings !== undefined) {
    return { agentId, used: true, origin: 'context' };
  }
  if (fallbackAvailable) {
    return { agentId, used: true, origin: 'fallback' };
  }
  return { agentId, used: false, origin: 'unavailable' };
}
