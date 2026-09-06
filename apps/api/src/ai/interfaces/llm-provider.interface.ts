import type { LLMProviderId } from '../types/common.js';
import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../types/llm.types.js';

// Provider-independent contract every LLM backend implements. The
// application (prompt building, parsing, tool orchestration, telemetry)
// depends only on this interface — never on a vendor SDK or a specific
// provider's wire format directly.
export interface LLMProvider {
  readonly id: LLMProviderId;

  supportsModel(model: string): boolean;

  listModels(): string[];

  generate(request: LLMRequest): Promise<LLMResponse>;

  // Async-iterable token stream. Implementations that don't yet support
  // streaming (the current placeholder providers) throw a ProviderError
  // synchronously rather than yielding — callers should check
  // `supportsStreaming()` first when streaming is optional.
  stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk>;

  supportsStreaming(): boolean;

  estimateCost(usage: { promptTokens: number; completionTokens: number }, model: string): number;
}
