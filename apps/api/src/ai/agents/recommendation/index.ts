import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerRecommendationTools } from './recommendation.tool.js';
import { RecommendationMemory } from './recommendation.memory.js';
import { recommendationAgentTelemetry } from './recommendation.telemetry.js';
import { RecommendationExecutor } from './recommendation.executor.js';
import { RecommendationAgentImpl } from './recommendation.agent.js';

// Composition root + self-registration for the Recommendation Agent —
// mirrors discovery/index.ts (Phase 18), risk/index.ts (Phase 19),
// compliance/index.ts (Phase 20). Importing this module (from
// routes/recommendation-agent.ts and services/jobs/job-dispatcher.ts) is
// what makes 'recommendation-agent' actually appear in
// orchestratorAgentRegistry — ESM caches the module, safe to import from
// multiple entry points without double-registering.
registerRecommendationTools(aiFoundation.toolRegistry);

const recommendationMemoryStore = new RedisMemoryStore(redis);
export const recommendationMemory = new RecommendationMemory(recommendationMemoryStore);
export const recommendationExecutor = new RecommendationExecutor(
  aiFoundation.toolRegistry,
  recommendationMemory,
  recommendationAgentTelemetry,
);
export const recommendationAgent = new RecommendationAgentImpl(recommendationExecutor);

orchestratorAgentRegistry.register(recommendationAgent);

export * from './recommendation.types.js';
export * from './recommendation.interface.js';
export {
  recommendationEngineTool,
  findingLookupTool,
  assetLookupTool,
} from './recommendation.tool.js';
