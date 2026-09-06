import { z } from 'zod';
import type { ToolDefinition } from '../tool.types.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { RetrievalService } from '../../retrieval/retrieval.service.js';

// Wraps RetrievalService.search() as a Tool (Phase 24 spec #7 — "agents
// should use it through the Tool framework instead of directly"). Copilot
// (copilot.executor.ts) now calls `knowledge_search` via ToolRegistry
// rather than importing RetrievalService itself, so its RAG grounding
// goes through the same tool-call path (validation, telemetry,
// ToolExecutionTrace) every other tool call does.
const searchInputSchema = z.object({
  question: z.string().min(1),
  assetId: z.string().min(1).optional(),
  documentTypes: z
    .array(
      z.enum([
        'FINDING',
        'RECOMMENDATION',
        'REPORT',
        'COMPLIANCE_RESULT',
        'RISK_ASSESSMENT',
        'DISCOVERY_SUMMARY',
      ]),
    )
    .optional(),
  topK: z.number().int().positive().max(20).optional(),
  conversationId: z.string().min(1).optional(),
});
const searchOutputSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      documentType: z.string(),
      text: z.string(),
      score: z.number(),
    }),
  ),
  embeddingVersion: z.string(),
  latencyMs: z.number(),
});

export function createKnowledgeSearchTool(
  retrievalService: RetrievalService,
): ToolDefinition<z.infer<typeof searchInputSchema>, z.infer<typeof searchOutputSchema>> {
  return {
    id: 'knowledge_search',
    name: 'knowledge_search',
    description:
      'Semantic search over the Knowledge Store (Phase 23) — finds previously-indexed findings, recommendations, reports, compliance results, risk assessments, and discovery summaries relevant to a question.',
    permissions: ['read', 'database'],
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    async execute(input) {
      const result = await retrievalService.search({
        question: input.question,
        assetId: input.assetId,
        documentTypes: input.documentTypes,
        topK: input.topK,
        conversationId: input.conversationId,
      });
      return {
        documents: result.documents.map((doc) => ({
          id: doc.id,
          agent: doc.agent,
          documentType: doc.documentType,
          text: doc.text,
          score: doc.score,
        })),
        embeddingVersion: result.embeddingVersion,
        latencyMs: result.latencyMs,
      };
    },
  };
}

export function registerKnowledgeTools(
  toolRegistry: ToolRegistry,
  retrievalService: RetrievalService,
): void {
  toolRegistry.register(createKnowledgeSearchTool(retrievalService));
}
