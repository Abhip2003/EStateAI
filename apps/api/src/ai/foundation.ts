import { redis } from '../cache/redis.js';
import { aiConfig, type AIFoundationConfig } from './config/index.js';
import { LLMProviderFactory, LLMProviderRegistry, LLMClient } from './llm/index.js';
import { aiTelemetry } from './telemetry/index.js';
import { PromptRegistry } from './prompts/index.js';
import { ToolRegistry, ToolExecutor, toolTelemetry } from './tools/index.js';
import { RedisMemoryStore, ConversationMemory, SessionMemory } from './memory/index.js';

// Composition root for the AI foundation — the single place that wires
// config -> provider factory -> provider registry -> LLMClient -> shared
// registries/memory together with real dependencies (the project's redis
// singleton, the Prometheus/pino-backed telemetry recorder). Everything
// exported here is what a future agent phase (Orchestrator/Discovery/
// Risk/... agents) is expected to consume; nothing in this file is
// invoked by any existing route or service yet, so it has zero effect on
// current behavior.
//
// `createAIFoundation()` (rather than a bag of module-level singletons)
// keeps every piece constructor-injected — tests call it with a fake
// AIFoundationConfig/Redis client instead of monkey-patching module
// state.
export interface AIFoundation {
  config: AIFoundationConfig;
  llmProviderFactory: LLMProviderFactory;
  llmProviderRegistry: LLMProviderRegistry;
  llmClient: LLMClient;
  promptRegistry: PromptRegistry;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  conversationMemory: ConversationMemory;
  sessionMemory: SessionMemory;
}

export function createAIFoundation(config: AIFoundationConfig = aiConfig): AIFoundation {
  const llmProviderFactory = new LLMProviderFactory(config);
  const llmProviderRegistry = new LLMProviderRegistry(llmProviderFactory, config);
  const llmClient = new LLMClient(llmProviderRegistry.resolveDefault(), config, aiTelemetry);
  const memoryStore = new RedisMemoryStore(redis);
  const toolRegistry = new ToolRegistry();

  return {
    config,
    llmProviderFactory,
    llmProviderRegistry,
    llmClient,
    promptRegistry: new PromptRegistry(),
    toolRegistry,
    toolExecutor: new ToolExecutor(toolRegistry, toolTelemetry),
    conversationMemory: new ConversationMemory(memoryStore),
    sessionMemory: new SessionMemory(memoryStore),
  };
}

// Process-wide instance for callers that just want the default wiring
// (future routes/services) without building their own composition root.
export const aiFoundation = createAIFoundation();
