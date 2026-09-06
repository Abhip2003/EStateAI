import { AIError } from '../../errors/index.js';

// Base of the orchestrator's own error hierarchy — extends the Phase 16
// AIError base so orchestrator failures are still catchable as `AIError`
// by any generic AI-foundation error handling, while remaining
// distinguishable by name for orchestrator-specific handling.
export class OrchestratorError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}
