import { AIError } from './ai-error.js';

export class MemoryError extends AIError {
  readonly scope?: string;

  constructor(message: string, scope?: string) {
    super(scope ? `[${scope}] ${message}` : message);
    this.name = 'MemoryError';
    this.scope = scope;
  }
}
