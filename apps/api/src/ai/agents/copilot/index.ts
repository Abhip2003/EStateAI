import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerCopilotTools } from './copilot.tool.js';
import { CopilotMemory } from './copilot.memory.js';
import { copilotAgentTelemetry } from './copilot.telemetry.js';
import { CopilotExecutor } from './copilot.executor.js';
import { CopilotAgentImpl } from './copilot.agent.js';

// Composition root + self-registration for the Copilot Agent — mirrors
// discovery/risk/compliance/recommendation/report's index.ts pattern.
// Importing this module (from routes/copilot-agent.ts) is what makes
// 'copilot-agent' appear in orchestratorAgentRegistry, its tools appear
// in aiFoundation.toolRegistry, and completes all six of the original
// Phase 17 placeholder agent roles.
registerCopilotTools(aiFoundation.toolRegistry);

const copilotMemoryStore = new RedisMemoryStore(redis);
export const copilotMemory = new CopilotMemory(
  aiFoundation.conversationMemory,
  aiFoundation.sessionMemory,
  copilotMemoryStore,
);
export const copilotExecutor = new CopilotExecutor(
  aiFoundation.toolRegistry,
  copilotMemory,
  copilotAgentTelemetry,
  aiFoundation.toolExecutor,
);
export const copilotAgent = new CopilotAgentImpl(copilotExecutor);

orchestratorAgentRegistry.register(copilotAgent);

export * from './copilot.types.js';
export * from './copilot.interface.js';
export {
  riskLookupTool,
  complianceLookupTool,
  recommendationLookupTool,
  assetLookupTool,
} from './copilot.tool.js';
