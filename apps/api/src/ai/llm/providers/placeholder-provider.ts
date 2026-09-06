import type { LLMProvider } from '../../interfaces/llm-provider.interface.js';
import type { LLMProviderId } from '../../types/common.js';
import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../../types/llm.types.js';
import { ProviderError } from '../../errors/index.js';

// Shared base for providers this phase declares support for but does not
// yet implement (Anthropic, Gemini, Ollama, Azure OpenAI — per Phase 16:
// "Only implement OpenAI initially. Other providers should have
// interfaces/placeholders."). Each still fully satisfies LLMProvider so
// the factory/registry can list and reason about them; only generate()/
// stream() are unimplemented, and they fail loudly rather than silently
// returning empty output.
//
// Note: apps/api/src/services/ai/ already has a complete, working Claude
// provider used by the live /ai/generate and /copilot/chat endpoints —
// this placeholder is intentionally separate (see src/ai/README design
// note) and does not affect that existing functionality.
export abstract class PlaceholderProvider implements LLMProvider {
  abstract readonly id: LLMProviderId;
  protected abstract readonly models: string[];

  supportsModel(model: string): boolean {
    return this.models.includes(model);
  }

  listModels(): string[] {
    return [...this.models];
  }

  supportsStreaming(): boolean {
    return false;
  }

  estimateCost(): number {
    return 0;
  }

  generate(_request: LLMRequest): Promise<LLMResponse> {
    return Promise.reject(
      new ProviderError(
        this.id,
        `provider "${this.id}" is not yet implemented (Phase 16 scaffolding only)`,
      ),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await, require-yield -- intentionally never yields: this provider doesn't support streaming, so the generator's only job is to reject before producing a chunk
  async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    throw new ProviderError(this.id, `provider "${this.id}" does not support streaming yet`);
  }
}
