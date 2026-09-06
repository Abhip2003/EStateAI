// Re-exports of the Tool contract for callers that import from
// ai/tools/ directly (this directory is the framework's public face per
// the Phase 24 spec) — the underlying types still live in
// ai/types/tool.types.ts, alongside AIContext/LLM types, so nothing
// under ai/tools/ has to import from ai/types/ redundantly elsewhere.
export type { ToolDefinition, ToolExecutionResult, ToolPermission } from '../types/tool.types.js';
