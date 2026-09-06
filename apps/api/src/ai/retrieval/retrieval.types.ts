import type { KnowledgeDocumentType } from '../knowledge/knowledge.types.js';

export interface RetrievalQuery {
  question: string;
  assetId?: string;
  documentTypes?: KnowledgeDocumentType[];
  agent?: string;
  tags?: string[];
  topK?: number;
  conversationId?: string;
}

export interface RetrievedDocument {
  id: string;
  agent: string;
  documentType: KnowledgeDocumentType;
  text: string;
  score: number;
  createdAt: Date;
}

export interface RetrievalResult {
  documents: RetrievedDocument[];
  embeddingVersion: string;
  latencyMs: number;
}
