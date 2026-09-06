import type { OrchestrationContext } from '../orchestrator/execution.context.js';
import { knowledgeStore } from '../knowledge/index.js';
import { knowledgeTelemetry } from '../knowledge/knowledge.telemetry.js';
import type { IndexDocumentInput } from '../knowledge/knowledge.types.js';
import {
  documentsFromRiskOutput,
  documentsFromComplianceOutput,
  documentsFromRecommendationOutput,
  documentsFromReportOutput,
  documentsFromDiscoveryOutput,
} from './knowledge.adapters.js';

// The single call site wiring every agent's output into the Knowledge
// Store — invoked from orchestrator/executor.ts's onStepComplete for
// every successful step, so indexing is automatic for both the built-in
// workflows and any future one, with no per-agent code to remember to
// add. Never throws: a caller that can't produce a document
// (unrecognized agentId, malformed output) is a no-op, and any failure
// from KnowledgeStore itself is caught and only recorded via telemetry —
// indexing must never affect the workflow it's observing.
export async function indexAgentOutput(
  agentId: string,
  output: unknown,
  context: OrchestrationContext,
): Promise<void> {
  try {
    const documents = buildDocuments(agentId, output, context);
    if (documents.length === 0) return;
    await knowledgeStore.indexDocuments(documents);
  } catch (error) {
    knowledgeTelemetry.recordFailure(agentId, error);
  }
}

function buildDocuments(
  agentId: string,
  output: unknown,
  context: OrchestrationContext,
): IndexDocumentInput[] {
  if (!output || typeof output !== 'object') return [];

  switch (agentId) {
    case 'risk-agent':
      return documentsFromRiskOutput(output as Parameters<typeof documentsFromRiskOutput>[0]);
    case 'compliance-agent':
      return documentsFromComplianceOutput(
        output as Parameters<typeof documentsFromComplianceOutput>[0],
      );
    case 'recommendation-agent':
      return documentsFromRecommendationOutput(
        output as Parameters<typeof documentsFromRecommendationOutput>[0],
      );
    case 'report-agent':
      return documentsFromReportOutput(output as Parameters<typeof documentsFromReportOutput>[0]);
    case 'discovery-agent': {
      const assetId = context.assets[0]?.id;
      if (!assetId) return [];
      return documentsFromDiscoveryOutput(
        output as Parameters<typeof documentsFromDiscoveryOutput>[0],
        assetId,
      );
    }
    default:
      return [];
  }
}
