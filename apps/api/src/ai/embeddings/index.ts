import { config } from '../../config/env.js';
import type { EmbeddingProvider } from './embedding-provider.interface.js';
import { LocalHashEmbeddingProvider } from './providers/local-hash.provider.js';
import { OpenAIEmbeddingProvider } from './providers/openai-embedding.provider.js';
import { EmbeddingService } from './embedding.service.js';
import { embeddingTelemetry } from './embedding.telemetry.js';

export { EmbeddingService } from './embedding.service.js';
export type { EmbeddingProvider } from './embedding-provider.interface.js';
export { EMBEDDING_DIMENSION } from './types.js';
export type { EmbeddingResult } from './types.js';

// Selects the concrete EmbeddingProvider from config.embedding.provider —
// the one place in the codebase that knows the mapping from provider id
// to class, same role LLMProviderFactory plays for LLM providers.
function createEmbeddingProvider(): EmbeddingProvider {
  switch (config.embedding.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({
        apiKey: config.embedding.apiKey,
        apiUrl: config.embedding.apiUrl,
        model: config.embedding.model,
      });
    case 'local':
    default:
      return new LocalHashEmbeddingProvider();
  }
}

// Process-wide instance, same "singleton composition root" pattern as
// aiFoundation.
export const embeddingService = new EmbeddingService(createEmbeddingProvider(), embeddingTelemetry);
