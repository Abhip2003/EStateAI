import type { ToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tool-context.js';
import type { ToolResult } from './tool-result.js';
import type { ToolTelemetry } from './tool.telemetry.js';
import { assertPermitted } from './tool-permissions.js';
import { isToolAllowedForAgent } from './agent-tool-access.js';
import { ToolError } from './tool-error.js';

// The Phase 24 "generic tool framework" entry point: wraps ToolRegistry
// with permission enforcement, an agent-scoped allowlist, telemetry, and
// a persisted execution trace — everything ToolRegistry.execute() itself
// deliberately doesn't do, so every pre-Phase-24 call site that already
// calls `toolRegistry.execute()` directly keeps working unchanged.
// New call sites (Copilot's automatic tool selection, the manual
// tool-invocation route, every Phase 24 verify script) go through this
// class instead. Never throws: run() always resolves to a ToolResult,
// success or failure, so a bad tool call degrades gracefully rather than
// crashing whatever's calling it.
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly telemetry: ToolTelemetry,
  ) {}

  // Runs one tool call end to end: agent-allowlist check, permission
  // check, ToolRegistry.execute() (input/output validation + timing),
  // telemetry, and a persisted ToolExecutionTrace row — in that order,
  // so a denied call is recorded as denied, not as a generic failure.
  async run(
    toolName: string,
    rawInput: unknown,
    context: ToolContext,
    agentId?: string,
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    if (agentId && !isToolAllowedForAgent(agentId, toolName)) {
      return this.fail(
        toolName,
        agentId,
        rawInput,
        startedAt,
        `agent "${agentId}" is not permitted to call tool "${toolName}"`,
      );
    }

    try {
      const tool = this.registry.get(toolName);
      assertPermitted(tool);
    } catch (error) {
      return this.fail(toolName, agentId, rawInput, startedAt, message(error));
    }

    try {
      const output = await this.registry.execute(toolName, rawInput, context);
      const durationMs = Date.now() - startedAt;
      this.telemetry.recordCall({ tool: toolName, agent: agentId, success: true, durationMs });
      await this.telemetry.recordTrace({
        toolName,
        agentId,
        arguments: rawInput,
        success: true,
        durationMs,
      });
      return { success: true, toolName, agentId, output, durationMs };
    } catch (error) {
      return this.fail(toolName, agentId, rawInput, startedAt, message(error));
    }
  }

  private async fail(
    toolName: string,
    agentId: string | undefined,
    rawInput: unknown,
    startedAt: number,
    errorMessage: string,
  ): Promise<ToolResult> {
    const durationMs = Date.now() - startedAt;
    this.telemetry.recordCall({ tool: toolName, agent: agentId, success: false, durationMs });
    await this.telemetry.recordTrace({
      toolName,
      agentId,
      arguments: rawInput,
      success: false,
      error: errorMessage,
      durationMs,
    });
    return { success: false, toolName, agentId, error: errorMessage, durationMs };
  }
}

function message(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  return error instanceof Error ? error.message : 'tool execution failed';
}
