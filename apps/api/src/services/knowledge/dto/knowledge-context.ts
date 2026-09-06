import type { RetrievedItem } from './retrieval-result.js';

export interface KnowledgeContextMetadata {
  generatedAt: string;
  retrieversRun: string[];
  totalItemsRetrieved: number;
  totalItemsAfterDedup: number;
  totalItemsAfterTrim: number;
  estimatedTokens: number;
  truncated: boolean;
}

// The single, unified, strongly-typed object PromptBuilder now consumes
// instead of a freeform contextBlocks record. One bucket per retriever
// category, each already deduplicated/summarized/sorted by relevance and
// trimmed to config.knowledge.maxContextTokens by KnowledgeService.
export interface KnowledgeContext {
  assetId: string;
  resources: RetrievedItem[];
  relationships: RetrievedItem[];
  findings: RetrievedItem[];
  policies: RetrievedItem[];
  recommendations: RetrievedItem[];
  risk: RetrievedItem[];
  metadata: KnowledgeContextMetadata;
}
