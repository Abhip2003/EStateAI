import type { ZodType } from 'zod';
import type { AIContext } from './context.types.js';

// Declared capability a tool needs — Phase 24's permission model. Every
// tool in this codebase declares only 'read'-shaped permissions today
// ('read' itself, plus 'network'/'database'/'filesystem' for tools that
// reach an external system read-only); 'write' exists in the union so
// the model is expressive, but ToolExecutor (ai/tools/tool-executor.ts)
// refuses to run any tool that declares it — see tool-permissions.ts.
export type ToolPermission = 'read' | 'write' | 'network' | 'database' | 'filesystem';

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  // Optional, added in Phase 24 — defaults to `name` in ToolRegistry.register()
  // when omitted, so every tool registered before this phase (which only
  // ever set `name`) keeps working unchanged.
  id?: string;
  name: string;
  description: string;
  // Optional, added in Phase 24 — defaults to ['read'] when omitted, so
  // every pre-Phase-24 tool (all of which are read-only wraps of existing
  // services) is treated as declaring exactly the permission it already
  // had in practice, with no per-file edit required.
  permissions?: ToolPermission[];
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  execute(input: TInput, context: AIContext): Promise<TOutput>;
}

export interface ToolExecutionResult<TOutput = unknown> {
  toolName: string;
  output: TOutput;
  durationMs: number;
}
