import { AIError } from '../../errors/index.js';

// Base of the Discovery Agent's own error hierarchy — extends the Phase
// 16 AIError base, same flat `extends Error` + `this.name` convention
// used throughout this codebase. Most real discovery failures (bad
// credential, unreachable provider) are already handled inside the
// reused DiscoveryService/GitHubDiscoveryProvider and folded into a
// DiscoveryResult with success:false rather than thrown — these classes
// exist for the agent's own, narrower set of structural problems.
export class DiscoveryAgentError extends AIError {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryAgentError';
  }
}

// Thrown when the account's provider has no implemented tool set in
// provider.registry.ts (e.g. gitlab/aws/... — interfaces only, per Phase
// 18 scope). Distinct from the pre-existing
// services/discovery/discovery-errors.ts's UnsupportedDiscoveryProviderError,
// which governs the underlying DiscoveryService/DiscoveryProviderRegistry
// and is not touched by this phase.
export class UnsupportedAgentProviderError extends DiscoveryAgentError {
  readonly provider: string;

  constructor(provider: string) {
    super(`the Discovery Agent does not yet support provider "${provider}"`);
    this.name = 'UnsupportedAgentProviderError';
    this.provider = provider;
  }
}
