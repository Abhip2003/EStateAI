import { AIError } from './ai-error.js';

export class ToolExecutionError extends AIError {
  readonly toolName: string;
  readonly cause?: unknown;

  constructor(toolName: string, message: string, cause?: unknown) {
    super(`[${toolName}] ${message}`);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.cause = cause;
  }
}
