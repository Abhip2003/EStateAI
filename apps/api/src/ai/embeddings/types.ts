// Fixed vector width every EmbeddingProvider must produce, regardless of
// which model actually backs it — keeps the `vector(1536)` Postgres
// column meaningful across a future provider swap. Providers whose
// native model dimension differs pad/truncate to this width (see
// `toFixedWidth` in each provider).
export const EMBEDDING_DIMENSION = 1536;

export type EmbeddingProviderId = 'local' | 'openai';

// One embedded vector plus the version string that produced it, so
// callers (KnowledgeStore) can persist provenance alongside the vector.
export interface EmbeddingResult {
  embedding: number[];
  embeddingVersion: string;
}
