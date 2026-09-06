import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerGithubTools } from './github.tool.js';
import { DiscoveryMemory } from './discovery.memory.js';
import { discoveryAgentTelemetry } from './discovery.telemetry.js';
import { DiscoveryExecutor } from './discovery.executor.js';
import { DiscoveryAgentImpl } from './discovery.agent.js';

// Composition root + self-registration for the Discovery Agent — mirrors
// the pattern services/agents/agents/index.ts already established for
// the pre-existing agent system ("a side-effect-only index.ts that
// imports each concrete implementation and calls .register() on load").
// Importing this module (from routes/discovery.ts and
// services/jobs/job-dispatcher.ts) is what makes 'discovery-agent'
// actually appear in orchestratorAgentRegistry and its tools appear in
// aiFoundation.toolRegistry — ESM caches the module, so it's safe to
// import from multiple entry points without double-registering.
registerGithubTools(aiFoundation.toolRegistry);

const discoveryMemoryStore = new RedisMemoryStore(redis);
export const discoveryMemory = new DiscoveryMemory(discoveryMemoryStore);
export const discoveryExecutor = new DiscoveryExecutor(
  aiFoundation.toolRegistry,
  discoveryMemory,
  discoveryAgentTelemetry,
);
export const discoveryAgent = new DiscoveryAgentImpl(discoveryExecutor);

orchestratorAgentRegistry.register(discoveryAgent);

export * from './discovery.types.js';
export * from './discovery.interface.js';
export { discoveryToolProviderRegistry } from './provider.registry.js';
export { classifyDiscoveryIntent } from './discovery.prompts.js';
export {
  githubRepositoryTool,
  githubOrganizationTool,
  githubLanguageTool,
  githubTopicTool,
  githubBranchTool,
  githubContributorTool,
  githubReleaseTool,
  githubWorkflowTool,
  githubSecurityTool,
  githubSecretTool,
} from './github.tool.js';
