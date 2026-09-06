import type { DiscoveredResource } from '../discovery/dto/discovered-resource.js';

// Defensive: a well-behaved provider never returns the same
// (provider, providerResourceId) twice in one discover() call, but nothing
// guarantees that (a provider bug, pagination overlap, ...). Collapsing
// here keeps ResourceService's persist loop simple — it never has to
// reason about processing the same identity twice in one run. Last one
// wins, on the assumption that a later entry in the same batch is the
// fresher read.
class ResourceDeduplicator {
  dedupe(resources: DiscoveredResource[]): DiscoveredResource[] {
    const byIdentity = new Map<string, DiscoveredResource>();
    for (const resource of resources) {
      byIdentity.set(`${resource.provider}:${resource.providerResourceId}`, resource);
    }
    return [...byIdentity.values()];
  }
}

export const resourceDeduplicator = new ResourceDeduplicator();
