import type { FinishReason, LLMMessage, LLMProviderId, TokenUsage } from './common.js';

export interface GenerationParams {
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMRequest extends GenerationParams {
  messages: LLMMessage[];
}

export interface LLMResponse {
  provider: LLMProviderId;
  model: string;
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
  latencyMs: number;
  estimatedCostUsd: number;
}

// One incremental chunk of a streamed generation. `done: true` on the
// final chunk carries the aggregate usage/finishReason, mirroring how a
// consumer would reconstruct a full LLMResponse from the stream.
export interface LLMStreamChunk {
  delta: string;
  done: boolean;
  finishReason?: FinishReason;
  usage?: TokenUsage;
}
