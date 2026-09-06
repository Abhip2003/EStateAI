// Every LLM provider this foundation knows about — concrete today (openai)
// or interface/placeholder (everything else), per Phase 16 scope.
export type LLMProviderId = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'azure-openai';

export type MessageRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: MessageRole;
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
