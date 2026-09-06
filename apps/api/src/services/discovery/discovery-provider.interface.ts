import type { DiscoveredResource } from './dto/discovered-resource.js';

// Every provider (GitHub today; AWS/Azure/GCP/Stripe/Docker/Kubernetes/
// Slack/Notion/... later) implements this and nothing else — DiscoveryService
// and the routes only ever talk to this interface, never to a concrete
// provider class. discover() must return only DiscoveredResource[]; raw
// provider API responses must never escape the provider implementation.
export interface DiscoveryProvider {
  readonly name: string;

  discover(credential: string): Promise<DiscoveredResource[]>;

  // Whether this provider can discover only what changed since a previous
  // run (cursor/ETag/since-timestamp) rather than a full scan every time.
  // Extension point — no provider implements incremental discovery yet.
  supportsIncrementalSync(): boolean;

  // Cheap "is this credential still good" check, independent of discover().
  validate(credential: string): Promise<boolean>;
}
