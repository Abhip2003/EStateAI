import type { EmbeddingProvider } from '../embedding-provider.interface.js';
import { EMBEDDING_DIMENSION } from '../types.js';
import { ProviderError, RateLimitError } from '../../errors/index.js';

export interface OpenAIEmbeddingConfig {
  apiKey?: string;
  apiUrl: string;
  model: string;
}

interface OpenAIEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
}

// Real embeddings via OpenAI's /v1/embeddings endpoint. Same
// fetch-based, no-vendor-SDK style as ai/llm/providers/openai.provider.ts.
// Opt in via EMBEDDING_PROVIDER=openai; the local hash provider stays the
// default so this is never invoked without a configured OPENAI_API_KEY.
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly version: string;

  constructor(private readonly config: OpenAIEmbeddingConfig) {
    this.version = `openai-${config.model}-v1-${EMBEDDING_DIMENSION}`;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.batchEmbed([text]);
    return vector;
  }

  async batchEmbed(texts: string[]): Promise<number[][]> {
    if (!this.config.apiKey) {
      throw new ProviderError('openai-embedding', 'OPENAI_API_KEY is not configured');
    }
    if (texts.length === 0) return [];

    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
    });

    if (response.status === 429) {
      throw new RateLimitError('openai-embedding', 'OpenAI embeddings rate limit exceeded');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        'openai-embedding',
        `OpenAI embeddings request failed (${response.status}): ${body}`,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as OpenAIEmbeddingResponse;
    return payload.data
      .sort((a, b) => a.index - b.index)
      .map((item) => toFixedWidth(item.embedding));
  }
}

// Pads with zeros or truncates so every provider's output is comparable
// in the same fixed-width vector column, regardless of the underlying
// model's native dimension.
function toFixedWidth(vector: number[]): number[] {
  if (vector.length === EMBEDDING_DIMENSION) return vector;
  if (vector.length > EMBEDDING_DIMENSION) return vector.slice(0, EMBEDDING_DIMENSION);
  return [...vector, ...new Array<number>(EMBEDDING_DIMENSION - vector.length).fill(0)];
}
