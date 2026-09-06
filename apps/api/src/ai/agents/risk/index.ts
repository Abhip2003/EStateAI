import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerRiskTools } from './risk.tool.js';
import { RiskMemory } from './risk.memory.js';
import { riskAgentTelemetry } from './risk.telemetry.js';
import { RiskExecutor } from './risk.executor.js';
import { RiskAgentImpl } from './risk.agent.js';

// Composition root + self-registration for the Risk Agent — mirrors the
// pattern discovery/index.ts established in Phase 18. Importing this
// module (from routes/risk-agent.ts and services/jobs/job-dispatcher.ts)
// is what makes 'risk-agent' actually appear in orchestratorAgentRegistry
// and its tools appear in aiFoundation.toolRegistry — ESM caches the
// module, so it's safe to import from multiple entry points without
// double-registering.
registerRiskTools(aiFoundation.toolRegistry);

const riskMemoryStore = new RedisMemoryStore(redis);
export const riskMemory = new RiskMemory(riskMemoryStore);
export const riskExecutor = new RiskExecutor(
  aiFoundation.toolRegistry,
  riskMemory,
  riskAgentTelemetry,
);
export const riskAgent = new RiskAgentImpl(riskExecutor);

orchestratorAgentRegistry.register(riskAgent);

export * from './risk.types.js';
export * from './risk.interface.js';
export {
  riskEngineTool,
  assetLookupTool,
  findingStoreTool,
  repositoryRiskTool,
  secretsScannerTool,
  branchProtectionTool,
  workflowRiskTool,
  dependencyRiskTool,
  securityAlertTool,
} from './risk.tool.js';
