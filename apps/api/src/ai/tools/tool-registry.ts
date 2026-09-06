import type { ToolDefinition } from '../types/tool.types.js';
import type { AIContext } from '../types/context.types.js';
import { ToolExecutionError } from '../errors/index.js';

// Registry for tool *definitions* — this phase ships the framework only
// (name/description/inputSchema/outputSchema/execute contract) and
// registers none. Future agent phases register concrete tools here
// (e.g. a Discovery Agent's "list_github_repos" tool) without touching
// this class.
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  // Fills in `id`/`permissions` when a tool definition omits them (every
  // tool registered before Phase 24 only ever set `name`) — `id` defaults
  // to `name`, `permissions` defaults to `['read']`, the permission every
  // pre-Phase-24 tool already had in practice as a read-only wrap of an
  // existing service.
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new ToolExecutionError(tool.name, 'a tool with this name is already registered');
    }
    this.tools.set(tool.name, {
      ...tool,
      id: tool.id ?? tool.name,
      permissions: tool.permissions ?? ['read'],
    });
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolExecutionError(name, 'no such tool registered');
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  // Validates input against the tool's own schema, runs execute(), times
  // it, and validates the output against the tool's output schema before
  // returning — the single call path every future agent uses instead of
  // invoking tool.execute() directly, so schema validation and timing are
  // never skipped.
  async execute(name: string, rawInput: unknown, context: AIContext): Promise<unknown> {
    const tool = this.get(name);
    const parsedInput = tool.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      throw new ToolExecutionError(name, `invalid input: ${parsedInput.error.message}`);
    }

    const startedAt = Date.now();
    let output: unknown;
    try {
      output = await tool.execute(parsedInput.data, context);
    } catch (error) {
      throw new ToolExecutionError(
        name,
        error instanceof Error ? error.message : 'tool execution failed',
        error,
      );
    }
    const durationMs = Date.now() - startedAt;

    const parsedOutput = tool.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      throw new ToolExecutionError(
        name,
        `tool returned an invalid output: ${parsedOutput.error.message}`,
      );
    }

    context.toolHistory.push({
      toolName: name,
      input: parsedInput.data,
      output: parsedOutput.data,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    return parsedOutput.data;
  }
}
