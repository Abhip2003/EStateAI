import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  FindingSeverity,
  Recommendation,
  RecommendationStatus,
} from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface CreateRecommendationInput {
  findingId: string;
  priority: FindingSeverity;
  title: string;
  description: string;
  estimatedImpact?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateRecommendationInput {
  priority?: FindingSeverity;
  status?: RecommendationStatus;
  title?: string;
  description?: string;
  estimatedImpact?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface ListRecommendationsParams extends PaginationParams {
  assetId?: string;
  accountId?: string;
  findingId?: string;
  status?: RecommendationStatus;
  priority?: FindingSeverity;
  search?: string;
  sort?: 'createdAt' | 'updatedAt' | 'priority';
  order?: 'asc' | 'desc';
}

class RecommendationRepository {
  async create(data: CreateRecommendationInput): Promise<Recommendation> {
    return prisma.recommendation.create({ data });
  }

  async update(id: string, data: UpdateRecommendationInput): Promise<Recommendation | null> {
    try {
      return await prisma.recommendation.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async findById(id: string): Promise<Recommendation | null> {
    return prisma.recommendation.findUnique({ where: { id } });
  }

  async findByFindingId(findingId: string): Promise<Recommendation | null> {
    return prisma.recommendation.findUnique({ where: { findingId } });
  }

  async delete(id: string): Promise<Recommendation | null> {
    try {
      return await prisma.recommendation.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListRecommendationsParams): Promise<PaginatedResult<Recommendation>> {
    const findingIds = await this.resolveScopedFindingIds(params);

    const where: Prisma.RecommendationWhereInput = {
      ...(params.findingId ? { findingId: params.findingId } : {}),
      ...(findingIds ? { findingId: { in: findingIds } } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.priority ? { priority: params.priority } : {}),
      ...(params.search
        ? {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.recommendation.findMany({
        where,
        orderBy: { [params.sort ?? 'createdAt']: params.order ?? 'desc' },
        ...toSkipTake(params),
      }),
      prisma.recommendation.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  // assetId/accountId have no column here either — resolved via Resource
  // -> Finding.resourceId -> Finding.id, the same two-step pattern used
  // throughout the analysis and graph modules wherever there's no formal
  // FK to filter through directly.
  private async resolveScopedFindingIds(
    params: Pick<ListRecommendationsParams, 'assetId' | 'accountId'>,
  ): Promise<string[] | undefined> {
    if (!params.assetId && !params.accountId) {
      return undefined;
    }
    const resources = await prisma.resource.findMany({
      where: {
        ...(params.assetId ? { assetId: params.assetId } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
      },
      select: { id: true },
    });
    const resourceIds = resources.map((r) => r.id);
    if (resourceIds.length === 0) {
      return [];
    }
    const findings = await prisma.finding.findMany({
      where: { resourceId: { in: resourceIds } },
      select: { id: true },
    });
    return findings.map((f) => f.id);
  }
}

export const recommendationRepository = new RecommendationRepository();
