// Automatic tool selection (Phase 24 spec #8) — deterministic keyword
// matching from a chat message to a concrete Tool call, same "not an LLM
// call" reasoning copilot.intent.ts (Phase 22) and Planner.resolveWorkflowId()
// (Phase 17) already established for their own classification. Kept
// separate from copilot.intent.ts's CopilotIntent (EXPLAIN_RISK/etc.):
// tool selection decides *which raw tool to call*, intent classification
// decides *which existing-agent-data explanation to build* — a message
// can match a tool trigger without matching any CopilotIntent pattern
// ("list open github issues" isn't a risk/compliance/recommendation
// question at all).
export type ToolSelection =
  | { kind: 'github_issues' }
  | { kind: 'github_pull_requests' }
  | { kind: 'github_branches' }
  | { kind: 'knowledge_findings'; query: string }
  | { kind: 'count_findings' };

const TOOL_PATTERNS: { pattern: RegExp; select: (message: string) => ToolSelection }[] = [
  { pattern: /\b(list|show|open)\b.*\bissues\b/i, select: () => ({ kind: 'github_issues' }) },
  {
    pattern: /\b(list|show|open)\b.*\b(pull requests?|prs?)\b/i,
    select: () => ({ kind: 'github_pull_requests' }),
  },
  { pattern: /\b(list|show)\b.*\bbranches\b/i, select: () => ({ kind: 'github_branches' }) },
  {
    pattern: /\bsearch\b.*\b(previous|past|prior)\b.*\bfindings?\b/i,
    select: (message) => ({ kind: 'knowledge_findings', query: message }),
  },
  {
    pattern: /\b(count|how many)\b.*\bfindings?\b/i,
    select: () => ({ kind: 'count_findings' }),
  },
];

// Returns the first matching tool trigger, or undefined if the message
// doesn't match any — the caller (copilot.executor.ts) falls back to its
// normal intent-classification flow when nothing matches, so tool
// selection is additive, never a replacement for the Phase 22 behavior.
export function selectTool(message: string): ToolSelection | undefined {
  for (const { pattern, select } of TOOL_PATTERNS) {
    if (pattern.test(message)) {
      return select(message);
    }
  }
  return undefined;
}
