import { AIError } from '../errors/index.js';

export class GraphError extends AIError {
  readonly executionId?: string;

  constructor(message: string, executionId?: string) {
    super(message);
    this.name = 'GraphError';
    this.executionId = executionId;
  }
}
