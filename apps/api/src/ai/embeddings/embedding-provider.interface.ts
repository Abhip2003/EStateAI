// Provider-independent contract every embedding backend implements —
// mirrors the LLMProvider interface pattern in ai/interfaces so the
// application (KnowledgeStore, RetrievalService) never depends on a
// vendor SDK or wire format directly, and a future model/provider swap
// only requires adding a new class here, not touching any caller.
export interface EmbeddingProvider {
  readonly id: string;

  // A stable string identifying provider+model+dimension, stored on every
  // KnowledgeDocument/RetrievalTrace row so vectors produced by different
  // providers are never silently compared as if compatible.
  readonly version: string;

  embed(text: string): Promise<number[]>;

  batchEmbed(texts: string[]): Promise<number[][]>;
}
