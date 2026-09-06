import { embeddingService } from '../embeddings/index.js';
import { KnowledgeStore } from './knowledge.store.js';
import { knowledgeTelemetry } from './knowledge.telemetry.js';

export { KnowledgeStore } from './knowledge.store.js';
export { knowledgeRepository } from './knowledge.repository.js';
export type {
  IndexDocumentInput,
  KnowledgeDocumentRecord,
  KnowledgeDocumentType,
  KnowledgeSearchResult,
} from './knowledge.types.js';

// Process-wide instance, same composition-root pattern as aiFoundation /
// embeddingService.
export const knowledgeStore = new KnowledgeStore(embeddingService, knowledgeTelemetry);
