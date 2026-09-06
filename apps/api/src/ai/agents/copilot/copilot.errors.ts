import { AIError } from '../../errors/index.js';

export class CopilotAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotAgentError';
  }
}

// Thrown when the request carries no conversationId at all — a
// structural problem resolved before any tool call, never worth
// retrying. Unlike the other agents' MissingXTargetError, this is about
// conversationId (always required to key memory), not assetId (Copilot
// can legitimately answer some questions — e.g. "what can you help
// with?" — with no asset in scope at all).
export class MissingConversationIdError extends CopilotAgentError {
  constructor() {
    super('the Copilot Agent requires a conversationId to key conversation memory');
    this.name = 'MissingConversationIdError';
  }
}
