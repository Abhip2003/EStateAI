// Base of the AI foundation's error hierarchy. Every error thrown from
// src/ai/** extends this, mirroring the flat `extends Error` + `this.name`
// convention already used across the codebase (see
// services/auth/errors.ts, services/ai/ai-errors.ts) rather than
// introducing a new base-error pattern.
export class AIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIError';
  }
}
