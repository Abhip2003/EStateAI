// The provider-independent shape PromptBuilder produces ("Final Prompt" in
// the spec) — every provider adapter translates this into its own vendor
// wire format, but nothing outside a provider file ever sees vendor JSON.
export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIRequest {
  model: string;
  systemPrompt?: string;
  messages: AIMessage[];
  maxTokens: number;
  temperature?: number;
}
