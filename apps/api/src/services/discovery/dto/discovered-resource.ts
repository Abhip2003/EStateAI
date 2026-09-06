// Provider-independent shape every provider's discover() must return into.
// GitHub repos, AWS S3 buckets, Stripe customers, Google Drive folders —
// all normalize into this one DTO. Provider-specific JSON (snake_case
// field names, nested provider objects) must never appear here verbatim;
// each provider picks and renames only the fields worth surfacing.
export interface DiscoveredResource {
  provider: string;
  providerResourceId: string;
  resourceType: string;
  displayName: string;
  description?: string;
  externalUrl?: string;
  metadata: Record<string, unknown>;
  discoveredAt: Date;
}
