import { relationshipRepository } from '../../repositories/relationship.repository.js';
import { eventService } from '../assets/event.service.js';
import { stableStringify } from '../resources/resource-version.service.js';
import { relationshipExtractorRegistry } from './relationship-extractors.js';
import type { Requester } from '../assets/ownership.js';
import type { DiscoveredResource } from '../discovery/dto/discovered-resource.js';
import type { Prisma, Relationship, Resource } from '../../generated/prisma/client.js';

export interface UpsertRelationshipInput {
  fromResourceId: string;
  toResourceId: string;
  relationshipType: string;
  provider: string;
  metadata?: Prisma.InputJsonValue;
}

export type RelationshipChangeStatus = 'CREATED' | 'UPDATED' | 'UNCHANGED';

export interface ExtractAndPersistResult {
  created: number;
  updated: number;
  unchanged: number;
}

class RelationshipService {
  async upsert(
    input: UpsertRelationshipInput,
  ): Promise<{ relationship: Relationship; status: RelationshipChangeStatus }> {
    const existing = await relationshipRepository.findByIdentity(
      input.fromResourceId,
      input.toResourceId,
      input.relationshipType,
    );

    let status: RelationshipChangeStatus;
    if (!existing) {
      status = 'CREATED';
    } else if (stableStringify(existing.metadata ?? {}) !== stableStringify(input.metadata ?? {})) {
      status = 'UPDATED';
    } else {
      status = 'UNCHANGED';
    }

    const relationship = await relationshipRepository.upsert(input);
    return { relationship, status };
  }

  // Called by DiscoveryService right after ResourceService.persist() —
  // `persistedResources` gives this the real Resource.id for every
  // providerResourceId the extractor referenced. Edges pointing at a
  // providerResourceId that wasn't actually persisted (shouldn't happen,
  // but defensive) are silently skipped rather than failing the whole run.
  async extractAndPersist(
    provider: string,
    discoveredResources: DiscoveredResource[],
    persistedResources: Resource[],
    requester: Requester,
    assetId: string,
  ): Promise<ExtractAndPersistResult> {
    const idByProviderResourceId = new Map(
      persistedResources.map((r) => [r.providerResourceId, r.id]),
    );
    const extracted = relationshipExtractorRegistry.extract(provider, discoveredResources);

    const counts: ExtractAndPersistResult = { created: 0, updated: 0, unchanged: 0 };
    let anyChange = false;

    for (const edge of extracted) {
      const fromResourceId = idByProviderResourceId.get(edge.fromProviderResourceId);
      const toResourceId = idByProviderResourceId.get(edge.toProviderResourceId);
      if (!fromResourceId || !toResourceId) {
        continue;
      }

      const { relationship, status } = await this.upsert({
        fromResourceId,
        toResourceId,
        relationshipType: edge.relationshipType,
        provider,
      });

      if (status === 'CREATED') {
        counts.created += 1;
        anyChange = true;
        await this.emitEvent(assetId, requester, 'RELATIONSHIP_CREATED', relationship);
      } else if (status === 'UPDATED') {
        counts.updated += 1;
        anyChange = true;
        await this.emitEvent(assetId, requester, 'RELATIONSHIP_UPDATED', relationship);
      } else {
        counts.unchanged += 1;
      }
    }

    if (anyChange) {
      await this.emitGraphUpdatedEvent(assetId, requester, counts);
    }

    return counts;
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    type: string,
    relationship: Relationship,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type,
        severity: 'INFO',
        title: `${type} — ${relationship.relationshipType}`,
        metadata: {
          relationshipId: relationship.id,
          fromResourceId: relationship.fromResourceId,
          toResourceId: relationship.toResourceId,
          relationshipType: relationship.relationshipType,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }

  private async emitGraphUpdatedEvent(
    assetId: string,
    requester: Requester,
    counts: ExtractAndPersistResult,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type: 'GRAPH_UPDATED',
        severity: 'INFO',
        title: 'Graph updated',
        metadata: { ...counts },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const relationshipService = new RelationshipService();
