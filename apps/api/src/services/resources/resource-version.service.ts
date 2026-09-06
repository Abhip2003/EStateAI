import crypto from 'node:crypto';
import type { DiscoveredResource } from '../discovery/dto/discovered-resource.js';
import type { Resource } from '../../generated/prisma/client.js';

export type ResourceVersionStatus = 'NEW' | 'UPDATED' | 'UNCHANGED' | 'SOFT_DELETED';

// Recursively sorts object keys before stringifying — plain JSON.stringify
// only preserves insertion order, so two structurally identical metadata
// objects built in a different key order would otherwise hash differently.
// Array order is preserved (it's meaningful).
// Exported for reuse by RelationshipService, which needs the same
// key-order-independent content comparison for edge metadata.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type HashableResource = Pick<
  DiscoveredResource,
  'resourceType' | 'displayName' | 'description' | 'externalUrl' | 'metadata'
>;

class ResourceVersionService {
  // Content hash covers everything that would count as a meaningful change
  // to the resource — not provider/providerResourceId (that's identity,
  // not content) and not timestamps.
  computeHash(resource: HashableResource): string {
    const content = stableStringify({
      resourceType: resource.resourceType,
      displayName: resource.displayName,
      description: resource.description ?? null,
      externalUrl: resource.externalUrl ?? null,
      metadata: resource.metadata ?? {},
    });
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // SOFT_DELETED is never returned here — a hash/existing-row comparison
  // has nothing to compare against for a resource that's simply absent
  // from the current discovery batch. That classification happens in
  // ResourceService's separate diff pass (see findActiveByAccount).
  classify(
    existing: Resource | null,
    newHash: string,
  ): Exclude<ResourceVersionStatus, 'SOFT_DELETED'> {
    if (!existing || existing.deletedAt) {
      return 'NEW';
    }
    return existing.hash === newHash ? 'UNCHANGED' : 'UPDATED';
  }
}

export const resourceVersionService = new ResourceVersionService();
