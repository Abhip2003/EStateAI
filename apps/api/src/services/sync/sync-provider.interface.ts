// Standardized shape every provider's sync() must return — provider-specific
// response structures (GitHub's user object, an AWS DescribeInstances
// payload, ...) are consumed and translated inside the provider and must
// never leak past this boundary.
export interface SyncProviderResult {
  resourcesDiscovered: number;
  details?: Record<string, unknown>;
  warnings?: string[];
}

export interface SyncProvider {
  readonly name: string;

  // Cheap "is this credential still good" check, distinct from a full
  // sync() run.
  validateCredential(credential: string): Promise<boolean>;

  // "Is the provider's API reachable at all" — independent of any one
  // account's credential.
  healthCheck(): Promise<boolean>;

  sync(credential: string): Promise<SyncProviderResult>;

  // Called when an account is disconnected, for providers with a real
  // server-side revoke/deregister step. No-op is a valid implementation.
  disconnect(credential: string): Promise<void>;
}
