import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Resource } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface UpsertResourceInput {
  provider: string;
  providerResourceId: string;
  accountId: string;
  assetId: string;
  resourceType: string;
  displayName: string;
  description?: string;
  externalUrl?: string;
  metadata?: Prisma.InputJsonValue;
  hash: string;
}

export interface ListResourcesParams extends PaginationParams {
  assetId?: string;
  accountId?: string;
  provider?: string;
  resourceType?: string;
  includeDeleted?: boolean;
  name?: string;
  metadataKey?: string;
  metadataValue?: string;
  // Restricts results to this id set — how ResourceSearchService applies a
  // relationship-type filter without a formal Resource<->Relationship FK.
  ids?: string[];
  sort?: 'displayName' | 'lastSeen' | 'firstSeen' | 'createdAt';
  order?: 'asc' | 'desc';
}

class ResourceRepository {
  // Identity is (provider, providerResourceId) — never a separate insert
  // path. `firstSeen` is only ever set on create; `lastSeen` (and
  // deletedAt: null, undeleting a rediscovered resource) update every time.
  async upsert(data: UpsertResourceInput): Promise<Resource> {
    const now = new Date();
    return prisma.resource.upsert({
      where: {
        provider_providerResourceId: {
          provider: data.provider,
          providerResourceId: data.providerResourceId,
        },
      },
      create: {
        provider: data.provider,
        providerResourceId: data.providerResourceId,
        accountId: data.accountId,
        assetId: data.assetId,
        resourceType: data.resourceType,
        displayName: data.displayName,
        description: data.description,
        externalUrl: data.externalUrl,
        metadata: data.metadata,
        hash: data.hash,
        firstSeen: now,
        lastSeen: now,
      },
      update: {
        accountId: data.accountId,
        assetId: data.assetId,
        resourceType: data.resourceType,
        displayName: data.displayName,
        description: data.description,
        externalUrl: data.externalUrl,
        metadata: data.metadata,
        hash: data.hash,
        lastSeen: now,
        deletedAt: null,
      },
    });
  }

  async findByProviderAndProviderResourceId(
    provider: string,
    providerResourceId: string,
  ): Promise<Resource | null> {
    return prisma.resource.findUnique({
      where: { provider_providerResourceId: { provider, providerResourceId } },
    });
  }

  async findById(id: string): Promise<Resource | null> {
    return prisma.resource.findUnique({ where: { id } });
  }

  // Non-deleted resources currently attributed to this account — the set
  // ResourceService diffs a fresh discovery batch against to find
  // resources that disappeared from the provider.
  async findActiveByAccount(accountId: string): Promise<Resource[]> {
    return prisma.resource.findMany({ where: { accountId, deletedAt: null } });
  }

  // Same shape as findActiveByAccount, scoped to assetId instead — used by
  // RiskService to aggregate ASSET-scope risk across every account under
  // one asset.
  async findActiveByAsset(assetId: string): Promise<Resource[]> {
    return prisma.resource.findMany({ where: { assetId, deletedAt: null } });
  }

  // Same shape again, scoped to provider — used by ComplianceService for
  // PROVIDER-scope reports (admin-only, spans every asset/account).
  async findActiveByProvider(provider: string): Promise<Resource[]> {
    return prisma.resource.findMany({ where: { provider, deletedAt: null } });
  }

  // Every active resource platform-wide — used by ComplianceService for
  // OVERALL-scope report aggregation (admin-only).
  async findAllActive(): Promise<Resource[]> {
    return prisma.resource.findMany({ where: { deletedAt: null } });
  }

  async softDelete(id: string): Promise<Resource | null> {
    try {
      return await prisma.resource.update({ where: { id }, data: { deletedAt: new Date() } });
    } catch {
      return null;
    }
  }

  async list(params: ListResourcesParams): Promise<PaginatedResult<Resource>> {
    const where: Prisma.ResourceWhereInput = {
      ...(params.assetId ? { assetId: params.assetId } : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.resourceType ? { resourceType: params.resourceType } : {}),
      ...(params.includeDeleted ? {} : { deletedAt: null }),
      ...(params.name ? { displayName: { contains: params.name, mode: 'insensitive' } } : {}),
      ...(params.ids ? { id: { in: params.ids } } : {}),
      ...(params.metadataKey
        ? {
            metadata: {
              path: [params.metadataKey],
              ...(params.metadataValue !== undefined
                ? { equals: params.metadataValue }
                : { not: Prisma.JsonNull }),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.resource.findMany({
        where,
        orderBy: { [params.sort ?? 'lastSeen']: params.order ?? 'desc' },
        ...toSkipTake(params),
      }),
      prisma.resource.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async findByIds(ids: string[]): Promise<Resource[]> {
    if (ids.length === 0) {
      return [];
    }
    return prisma.resource.findMany({ where: { id: { in: ids } } });
  }

  async delete(id: string): Promise<Resource | null> {
    try {
      return await prisma.resource.delete({ where: { id } });
    } catch {
      return null;
    }
  }
}

export const resourceRepository = new ResourceRepository();
