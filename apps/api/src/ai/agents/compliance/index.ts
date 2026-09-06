import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerComplianceTools } from './compliance.tool.js';
import { ComplianceMemory } from './compliance.memory.js';
import { complianceAgentTelemetry } from './compliance.telemetry.js';
import { ComplianceExecutor } from './compliance.executor.js';
import { ComplianceAgentImpl } from './compliance.agent.js';

// Composition root + self-registration for the Compliance Agent — mirrors
// the pattern discovery/index.ts (Phase 18) and risk/index.ts (Phase 19)
// established. Importing this module (from routes/compliance-agent.ts and
// services/jobs/job-dispatcher.ts) is what makes 'compliance-agent'
// actually appear in orchestratorAgentRegistry and its tools appear in
// aiFoundation.toolRegistry — ESM caches the module, so it's safe to
// import from multiple entry points without double-registering.
registerComplianceTools(aiFoundation.toolRegistry);

const complianceMemoryStore = new RedisMemoryStore(redis);
export const complianceMemory = new ComplianceMemory(complianceMemoryStore);
export const complianceExecutor = new ComplianceExecutor(
  aiFoundation.toolRegistry,
  complianceMemory,
  complianceAgentTelemetry,
);
export const complianceAgent = new ComplianceAgentImpl(complianceExecutor);

orchestratorAgentRegistry.register(complianceAgent);

export * from './compliance.types.js';
export * from './compliance.interface.js';
export { listFrameworks } from './compliance.mapping.js';
export {
  complianceEngineTool,
  policyLookupTool,
  findingLookupTool,
  assetLookupTool,
  frameworkMappingTool,
  controlCoverageTool,
  evidenceTool,
  complianceStoreTool,
} from './compliance.tool.js';
