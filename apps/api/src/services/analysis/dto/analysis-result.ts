// Returned by FindingService.evaluateResources() — summarizes one
// discovery-triggered (or manually triggered) analysis pass. Consumed by
// DiscoveryService for DiscoveryResult.analysis and by
// verify-analysis.ts's observability assertions.
export interface AnalysisResult {
  rulesExecuted: number;
  resourcesEvaluated: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsResolved: number;
  recommendationsGenerated: number;
  durationMs: number;
}
