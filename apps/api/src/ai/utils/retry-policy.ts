// Shared retry classification, consumed by WorkflowEngine.runStep()
// (via isRetryableError) and exposed to the planner/reasoning layer for
// explainability. Lives in ai/utils/ (not ai/planner/ or
// ai/orchestrator/) specifically to avoid a cycle: ai/planner imports
// from ai/orchestrator, so a classifier orchestrator itself depends on
// can't live inside ai/planner.
export type RetryClassification = 'RECOVERABLE' | 'PERMANENT';

// Error names that must never be retried regardless of message content —
// retrying a permission/validation/auth failure just repeats the same
// rejection at extra latency/cost.
const PERMANENT_ERROR_NAMES = new Set([
  'UnauthorizedError',
  'ForbiddenError',
  'InvalidCredentialsError',
  'InvalidRefreshTokenError',
  'RefreshTokenReuseError',
  'ValidationError',
  'ZodError',
]);

const PERMANENT_MESSAGE_PATTERN =
  /\b(permission denied|forbidden|unauthorized|not authenticated|invalid credentials|validation failed)\b/i;

// Defaults to RECOVERABLE for anything not explicitly recognized as
// permanent — this preserves the pre-Phase-25 behavior (retry every
// error except a cancellation) for the generic `Error`s most existing
// agents/tools throw (tool timeouts, transient API failures, DB
// timeouts), while carving out the "never retry" cases the Phase 25 spec
// calls out by name.
export function classifyError(error: unknown): RetryClassification {
  if (error instanceof Error) {
    if (PERMANENT_ERROR_NAMES.has(error.name)) return 'PERMANENT';
    if (PERMANENT_MESSAGE_PATTERN.test(error.message)) return 'PERMANENT';
  }
  return 'RECOVERABLE';
}

export function isRetryableError(error: unknown): boolean {
  return classifyError(error) === 'RECOVERABLE';
}
