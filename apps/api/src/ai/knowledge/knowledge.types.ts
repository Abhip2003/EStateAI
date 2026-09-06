// Mirrors Prisma's KnowledgeDocumentType enum as a plain union so
// non-Prisma-aware modules (EmbeddingService callers, verify scripts)
// don't need to import the generated client just to reference a type
// name.
export type KnowledgeDocumentType =
  | 'FINDING'
  | 'RECOMMENDATION'
  | 'REPORT'
  | 'COMPLIANCE_RESULT'
  | 'RISK_ASSESSMENT'
  | 'DISCOVERY_SUMMARY'
  // Phase 30 — episodic-memory summaries, indexed via the same
  // KnowledgeStore/RetrievalService as every other document type.
  | 'EPISODE';

// Input to KnowledgeStore.index() — one document about to be embedded and
// persisted. `sourceId` is the id of the row this document summarizes
// (a Finding id, a Recommendation id, ...) so a document can be
// re-indexed (upserted) instead of duplicated when the same agent output
// is indexed again.
export interface IndexDocumentInput {
  assetId: string;
  agent: string;
  documentType: KnowledgeDocumentType;
  text: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  sourceId?: string;
}

export interface KnowledgeDocumentRecord {
  id: string;
  assetId: string;
  agent: string;
  documentType: KnowledgeDocumentType;
  text: string;
  metadata: Record<string, unknown>;
  tags: string[];
  embeddingVersion: string;
  sourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchKnowledgeInput {
  query: string;
  assetId?: string;
  documentTypes?: KnowledgeDocumentType[];
  agent?: string;
  tags?: string[];
  topK?: number;
}

export interface KnowledgeSearchResult extends KnowledgeDocumentRecord {
  score: number;
}
