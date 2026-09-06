import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../embedding-provider.interface.js';
import { EMBEDDING_DIMENSION } from '../types.js';

// Dependency-free, deterministic embedding provider: hashes each token
// into a bucket of a fixed-width vector (a variant of the "hashing
// trick"), then L2-normalizes so cosine similarity behaves sensibly.
// This is not a semantic model — it captures token overlap, not meaning
// — but it is the default provider (see config/env.ts EMBEDDING_PROVIDER)
// so indexing/retrieval/Copilot grounding all work in dev/CI with zero
// external dependency or API key, the same "graceful default over a hard
// external dependency" precedent used by every LLM-narration fallback
// elsewhere in ai/agents/*/*.summary.ts.
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local';
  readonly version = `local-hash-v1-${EMBEDDING_DIMENSION}`;

  embed(text: string): Promise<number[]> {
    return Promise.resolve(this.hashEmbed(text));
  }

  batchEmbed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.hashEmbed(text)));
  }

  private hashEmbed(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0);

    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSION;
      // Second hash byte range picks a sign so unrelated tokens don't all
      // push the same bucket in the same direction.
      const sign = digest[4] % 2 === 0 ? 1 : -1;
      vector[bucket] += sign;
    }

    return normalize(vector);
  }
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}
