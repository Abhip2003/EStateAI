import { AIError } from '../errors/index.js';

export class ApprovalError extends AIError {
  readonly approvalId?: string;

  constructor(message: string, approvalId?: string) {
    super(message);
    this.name = 'ApprovalError';
    this.approvalId = approvalId;
  }
}
