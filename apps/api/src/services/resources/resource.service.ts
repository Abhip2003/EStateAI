import { resourceRepository } from '../../repositories/resource.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, isOwnerOrAdmin, type Requester } from '../assets/ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import { ResourceNotFoundError } from './resource-errors.js';
import { resourceDeduplicator } from './resource-deduplicator.js';
import { resourceVersionService } from './resource-version.service.js';
import type { DiscoveredResource } from '../discovery/dto/discovered-resource.js';
import type { Prisma, Resource } from '../../generated/prisma/client.js';

export interface PersistResourcesInput {
  accountId: string;
  assetId: string;
  resources: DiscoveredResource[];
  requester: Requester;
}

export interface PersistResourcesResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  // Every resource touched by this run (created/updated/unchanged) —
  // consumed by RelationshipService.extractAndPersist to map
  // providerResourceId identities to real Resource.id values.
  resources: Resource[];
}

// Exported for GraphService/ResourceSearchService — resolves+authorizes a
// resource by its own assetId, the same ownership pattern every other
// domain in this codebase uses (getOwnedAccount, getOwnedAsset, ...).
export async function getOwnedResource(
  resourceId: string,
  requester: Requester,
): Promise<Resource> {
  const resource = await resourceRepository.findById(resourceId);
  if (!resource) {
    throw new ResourceNotFoundError(resourceId);
  }
  const asset = await getOwnedAsset(resource.assetId, requester);
  if (!isOwnerOrAdmin(asset, requester)) {
    throw new ForbiddenError('You do not have access to this resource');
  }
  return resource;
}

class ResourceService {
  // Called by DiscoveryService right after a successful provider.discover()
  // — normalize (already done by the provider) → persist (here) → events
  // (here, one per resource, via the existing eventService). Never touches
  // the network; every resource here is already a DiscoveredResource.
  async persist(input: PersistResourcesInput): Promise<PersistResourcesResult> {
    const deduped = resourceDeduplicator.dedupe(input.resources);
    const counts: Omit<PersistResourcesResult, 'resources'> = {
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
    };
    const touched: Resource[] = [];
    const seenIdentities = new Set<string>();

    for (const discovered of deduped) {
      seenIdentities.add(`${discovered.provider}:${discovered.providerResourceId}`);

      const existing = await resourceRepository.findByProviderAndProviderResourceId(
        discovered.provider,
        discovered.providerResourceId,
      );
      const hash = resourceVersionService.computeHash(discovered);
      const status = resourceVersionService.classify(existing, hash);

      const saved = await resourceRepository.upsert({
        provider: discovered.provider,
        providerResourceId: discovered.providerResourceId,
        accountId: input.accountId,
        assetId: input.assetId,
        resourceType: discovered.resourceType,
        displayName: discovered.displayName,
        description: discovered.description,
        externalUrl: discovered.externalUrl,
        metadata: discovered.metadata as Prisma.InputJsonValue,
        hash,
      });

      touched.push(saved);

      if (status === 'NEW') {
        counts.created += 1;
        await this.emitEvent(input, 'RESOURCE_CREATED', saved);
      } else if (status === 'UPDATED') {
        counts.updated += 1;
        await this.emitEvent(input, 'RESOURCE_UPDATED', saved);
      } else {
        counts.unchanged += 1;
        await this.emitEvent(input, 'RESOURCE_DISCOVERED', saved);
      }
    }

    // Diff pass: anything this account previously discovered that wasn't
    // in this batch has disappeared from the provider (deleted repo,
    // revoked access, ...) — soft-delete it rather than leaving a stale
    // active row.
    const previouslyActive = await resourceRepository.findActiveByAccount(input.accountId);
    for (const resource of previouslyActive) {
      if (seenIdentities.has(`${resource.provider}:${resource.providerResourceId}`)) {
        continue;
      }
      const deleted = await resourceRepository.softDelete(resource.id);
      if (deleted) {
        counts.deleted += 1;
        await this.emitEvent(input, 'RESOURCE_DELETED', deleted);
      }
    }

    return { ...counts, resources: touched };
  }

  // Best-effort, same reasoning as JobExecutor.emitEvent — an event
  // failure must never mask the persistence outcome that already happened.
  private async emitEvent(
    input: PersistResourcesInput,
    type: string,
    resource: Resource,
  ): Promise<void> {
    try {
      await eventService.createForAsset(input.assetId, input.requester, {
        type,
        severity: 'INFO',
        title: `${type} — ${resource.resourceType} "${resource.displayName}"`,
        metadata: {
          resourceId: resource.id,
          provider: resource.provider,
          providerResourceId: resource.providerResourceId,
          accountId: input.accountId,
        },
      });
    } catch {
      // Swallowed intentionally — see doc comment above.
    }
  }
}

export const resourceService = new ResourceService();
