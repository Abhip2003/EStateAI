// `ToolError` per the Phase 24 spec — an alias for the existing
// ToolExecutionError (ai/errors/tool-execution-error.ts), which every
// tool call already throws (ToolRegistry.execute() wraps every
// validation/execution failure in one). A second, parallel error class
// would just mean callers had to check `instanceof` twice; re-exporting
// under the spec's name keeps one error type for the whole framework.
export { ToolExecutionError as ToolError } from '../errors/index.js';
