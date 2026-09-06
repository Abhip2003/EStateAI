// Public surface of the AI foundation (Phase 16). Future agent phases
// (Orchestrator/Discovery/Risk/Compliance/Recommendation/Report/Copilot
// Agents) import from here rather than reaching into individual
// subdirectories.
export * from './types/common.js';
export * from './types/llm.types.js';
export * from './types/prompt.types.js';
export * from './types/tool.types.js';
export * from './types/context.types.js';
export * from './types/memory.types.js';

export * from './interfaces/index.js';
export * from './errors/index.js';
export * from './config/index.js';
export * from './utils/index.js';
export * from './llm/index.js';
export * from './prompts/index.js';
export * from './parser/index.js';
export * from './tools/index.js';
export * from './context/index.js';
export * from './memory/index.js';
export * from './telemetry/index.js';

export { createAIFoundation, aiFoundation } from './foundation.js';
export type { AIFoundation } from './foundation.js';

// Phase 17 — Orchestrator Agent. Re-exported here so it's reachable the
// same way as everything else in this barrel; see orchestrator/index.ts
// for its own internal organization.
export * from './orchestrator/index.js';
