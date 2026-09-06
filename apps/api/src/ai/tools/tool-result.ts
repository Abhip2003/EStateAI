// Envelope returned by ToolExecutor.run() — unlike ToolRegistry.execute()
// (which throws on any failure, the contract every pre-Phase-24 agent
// executor already depends on), ToolExecutor never throws: a failed tool
// call becomes `{success: false, error}` instead of an exception. This is
// what makes automatic tool selection (Copilot, spec #8) safe to wire
// into a conversation — a bad tool call degrades the answer, it never
// crashes the request.
export interface ToolResult<TOutput = unknown> {
  success: boolean;
  toolName: string;
  agentId?: string;
  output?: TOutput;
  error?: string;
  durationMs: number;
}
