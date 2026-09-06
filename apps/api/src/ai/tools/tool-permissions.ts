import type { ToolDefinition, ToolPermission } from '../types/tool.types.js';
import { ToolError } from './tool-error.js';

// Every permission a tool is allowed to declare and actually be run with,
// today — 'write' is a real member of the ToolPermission union (so a
// future write-capable tool can express itself honestly) but is
// deliberately absent here, per the Phase 24 spec's explicit "Current
// implementation: read-only everywhere". ToolExecutor calls
// assertPermitted() before every run; a tool that declares 'write' is
// refused, not silently downgraded.
const ALLOWED_PERMISSIONS: ReadonlySet<ToolPermission> = new Set([
  'read',
  'network',
  'database',
  'filesystem',
]);

// Throws ToolError if a tool declares any permission this deployment
// doesn't grant (currently: anything other than read/network/database/
// filesystem — i.e. 'write'). Called by ToolExecutor before every run,
// so a permission violation is caught centrally rather than trusted to
// each tool's own execute() to self-police.
export function assertPermitted(tool: ToolDefinition): void {
  const permissions = tool.permissions ?? ['read'];
  const denied = permissions.filter((permission) => !ALLOWED_PERMISSIONS.has(permission));
  if (denied.length > 0) {
    throw new ToolError(
      tool.name,
      `tool declares a permission not granted in this deployment: ${denied.join(', ')}`,
    );
  }
}
