import { config } from '../../config/env.js';
import type { LLMProviderId } from '../types/common.js';

export interface ProviderConfig {
  apiKey?: string;
  apiUrl: string;
}

// Centralized configuration for the AI foundation — model defaults,
// sampling params, timeouts, retries, streaming, and per-provider
// credentials/endpoints. Deliberately reads from the existing
// `config.ai` object (apps/api/src/config/env.ts) rather than
// re-parsing `process.env` a second time: env vars are validated once,
// at process startup, by the project's single zod schema. This module
// only adds foundation-specific defaults (temperature/topP/streaming)
// that config.ai doesn't carry, plus placeholder provider config for
// providers env.ts doesn't define yet (Ollama, Azure OpenAI).
export interface AIFoundationConfig {
  defaultProvider: LLMProviderId;
  defaultModel: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  streamingEnabled: boolean;
  providers: Record<LLMProviderId, ProviderConfig>;
}

// This foundation's default provider is deliberately independent of the
// existing AI_PROVIDER env var — that setting governs the legacy
// services/ai/ system (which already has working Claude/OpenAI/Gemini
// providers). Here, only OpenAI is concretely implemented per Phase 16
// scope, so it's the only sensible default; anthropic/gemini/ollama/
// azure-openai are placeholders that throw if selected (see
// llm/providers/placeholder-provider.ts). A future phase that finishes
// implementing another provider can make it the default once it's real.
const DEFAULT_PROVIDER: LLMProviderId = 'openai';

export function loadAIConfig(): AIFoundationConfig {
  return Object.freeze({
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: 'gpt-4o-mini',
    temperature: 0.7,
    topP: 1,
    maxTokens: config.ai.defaultMaxTokens,
    timeoutMs: config.ai.requestTimeoutMs,
    maxRetries: config.ai.maxRetries,
    retryBackoffMs: config.ai.retryBackoffMs,
    streamingEnabled: true,
    providers: Object.freeze({
      openai: Object.freeze({
        apiKey: config.ai.openai.apiKey,
        apiUrl: config.ai.openai.apiUrl,
      }),
      anthropic: Object.freeze({
        apiKey: config.ai.claude.apiKey,
        apiUrl: config.ai.claude.apiUrl,
      }),
      gemini: Object.freeze({
        apiKey: config.ai.gemini.apiKey,
        apiUrl: config.ai.gemini.apiUrl,
      }),
      // No env vars exist for these yet — placeholders only, per Phase 16
      // scope ("other providers should have interfaces/placeholders").
      // A future phase that actually implements one of these adds its
      // OLLAMA_*/AZURE_OPENAI_* vars to env.ts and wires them in here.
      ollama: Object.freeze({
        apiKey: undefined,
        apiUrl: 'http://localhost:11434/api/chat',
      }),
      'azure-openai': Object.freeze({
        apiKey: undefined,
        apiUrl: '',
      }),
    }),
  });
}

export const aiConfig = loadAIConfig();
