import { AIError } from './ai-error.js';

// Thrown by prompts/ when a template is missing required variables, a
// variable fails its schema, or an unknown template id/version is
// requested.
export class PromptError extends AIError {
  readonly templateId?: string;

  constructor(message: string, templateId?: string) {
    super(templateId ? `[${templateId}] ${message}` : message);
    this.name = 'PromptError';
    this.templateId = templateId;
  }
}
