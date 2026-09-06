import { aiFoundation } from '../../foundation.js';
import { orchestratorAgentRegistry } from '../../orchestrator/agent-registry.js';
import { redis } from '../../../cache/redis.js';
import { RedisMemoryStore } from '../../memory/redis-memory-store.js';
import { registerReportTools } from './report.tool.js';
import { ReportMemory } from './report.memory.js';
import { reportAgentTelemetry } from './report.telemetry.js';
import { ReportExecutor } from './report.executor.js';
import { ReportAgentImpl } from './report.agent.js';

// Composition root + self-registration for the Report Agent — mirrors
// every other agent's index.ts (discovery/risk/compliance/recommendation).
// Importing this module (from routes/report-agent.ts and
// services/jobs/job-dispatcher.ts) is what makes 'report-agent' actually
// appear in orchestratorAgentRegistry.
registerReportTools(aiFoundation.toolRegistry);

const reportMemoryStore = new RedisMemoryStore(redis);
export const reportMemory = new ReportMemory(reportMemoryStore);
export const reportExecutor = new ReportExecutor(
  aiFoundation.toolRegistry,
  reportMemory,
  reportAgentTelemetry,
);
export const reportAgent = new ReportAgentImpl(reportExecutor);

orchestratorAgentRegistry.register(reportAgent);

export * from './report.types.js';
export * from './report.interface.js';
export { assetLookupTool } from './report.tool.js';
