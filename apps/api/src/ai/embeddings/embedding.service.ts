import type { EmbeddingProvider } from './embedding-provider.interface.js';
import type { EmbeddingTelemetry } from './embedding.telemetry.js';
import type { EmbeddingResult } from './types.js';
import { withRetry } from '../utils/retry.js';
import { RateLimitError } from '../errors/index.js';

// The public embedding abstraction every caller (KnowledgeStore,
// RetrievalService, Copilot) uses — `embed`/`batchEmbed` per the Phase 23
// spec. Wraps a single injected EmbeddingProvider (selected once, at
// composition-root time, from EMBEDDING_PROVIDER — see embeddings/index.ts)
// with retry-on-rate-limit and telemetry, the same shape LLMClient wraps
// LLMProvider. Swapping models/providers later means adding a new
// EmbeddingProvider and changing EMBEDDING_PROVIDER — no caller of this
// class changes.
export class EmbeddingService {
  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly telemetry?: EmbeddingTelemetry,
  ) {}

  get embeddingVersion(): string {
    return this.provider.version;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const [embedding] = await this.batchEmbedRaw([text]);
    return { embedding: embedding, embeddingVersion: this.provider.version };
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingResult[]> {
    const vectors = await this.batchEmbedRaw(texts);
    return vectors.map((embedding) => ({ embedding, embeddingVersion: this.provider.version }));
  }

  private async batchEmbedRaw(texts: string[]): Promise<number[][]> {
    const startedAt = Date.now();
    try {
      const vectors = await withRetry(() => this.provider.batchEmbed(texts), {
        retries: 2,
        backoffMs: 250,
        isRetryable: (error) => error instanceof RateLimitError,
      });
      this.telemetry?.recordCall({
        provider: this.provider.id,
        success: true,
        durationMs: Date.now() - startedAt,
        count: texts.length,
      });
      return vectors;
    } catch (error) {
      this.telemetry?.recordCall({
        provider: this.provider.id,
        success: false,
        durationMs: Date.now() - startedAt,
        count: texts.length,
      });
      throw error;
    }
  }
}
