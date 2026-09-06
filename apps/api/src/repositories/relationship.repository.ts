import { prisma } from '../db/prisma.js';
import type { Prisma, Relationship } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface UpsertRelationshipInput {
  fromResourceId: string;
  toResourceId: string;
  relationshipType: string;
  provider: string;
  metadata?: Prisma.InputJsonValue;
}

export interface ListRelationshipsParams extends PaginationParams {
  relationshipType?: string;
  provider?: string;
}

class RelationshipRepository {
  // Identity is (fromResourceId, toResourceId, relationshipType) — same
  // upsert-only discipline as ResourceRepository, so rediscovery never
  // duplicates an edge.
  async upsert(data: UpsertRelationshipInput): Promise<Relationship> {
    return prisma.relationship.upsert({
      where: {
        fromResourceId_toResourceId_relationshipType: {
          fromResourceId: data.fromResourceId,
          toResourceId: data.toResourceId,
          relationshipType: data.relationshipType,
        },
      },
      create: {
        fromResourceId: data.fromResourceId,
        toResourceId: data.toResourceId,
        relationshipType: data.relationshipType,
        provider: data.provider,
        metadata: data.metadata,
      },
      update: {
        provider: data.provider,
        metadata: data.metadata,
      },
    });
  }

  async findByIdentity(
    fromResourceId: string,
    toResourceId: string,
    relationshipType: string,
  ): Promise<Relationship | null> {
    return prisma.relationship.findUnique({
      where: {
        fromResourceId_toResourceId_relationshipType: {
          fromResourceId,
          toResourceId,
          relationshipType,
        },
      },
    });
  }

  // Outgoing edges — used by GraphService.children()/neighbors().
  async findByFromResource(resourceId: string): Promise<Relationship[]> {
    return prisma.relationship.findMany({ where: { fromResourceId: resourceId } });
  }

  // Incoming edges — used by GraphService.parents()/neighbors().
  async findByToResource(resourceId: string): Promise<Relationship[]> {
    return prisma.relationship.findMany({ where: { toResourceId: resourceId } });
  }

  // Batch variants for BFS traversal (connectedResources/pathExists),
  // where each hop needs edges for an entire frontier at once rather than
  // one resource at a time.
  async findByFromResourceIds(resourceIds: string[]): Promise<Relationship[]> {
    if (resourceIds.length === 0) return [];
    return prisma.relationship.findMany({ where: { fromResourceId: { in: resourceIds } } });
  }

  async findByToResourceIds(resourceIds: string[]): Promise<Relationship[]> {
    if (resourceIds.length === 0) return [];
    return prisma.relationship.findMany({ where: { toResourceId: { in: resourceIds } } });
  }

  // Every edge of a given type, either direction — used by
  // ResourceSearchService's relationship filter.
  async findByType(relationshipType: string): Promise<Relationship[]> {
    return prisma.relationship.findMany({ where: { relationshipType } });
  }

  async list(params: ListRelationshipsParams): Promise<PaginatedResult<Relationship>> {
    const where: Prisma.RelationshipWhereInput = {
      ...(params.relationshipType ? { relationshipType: params.relationshipType } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.relationship.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(params),
      }),
      prisma.relationship.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async delete(id: string): Promise<Relationship | null> {
    try {
      return await prisma.relationship.delete({ where: { id } });
    } catch {
      return null;
    }
  }
}

export const relationshipRepository = new RelationshipRepository();
