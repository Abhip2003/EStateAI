import { AIError } from './ai-error.js';

// Thrown by parser/structured-output-parser.ts when a model response
// fails JSON parsing or zod schema validation, after retries are
// exhausted. Carries the raw text and validation issues for logging.
export class ParsingError extends AIError {
  readonly raw: string;
  readonly issues?: string[];

  constructor(message: string, raw: string, issues?: string[]) {
    super(message);
    this.name = 'ParsingError';
    this.raw = raw;
    this.issues = issues;
  }
}
