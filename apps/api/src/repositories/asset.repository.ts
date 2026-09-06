import { prisma } from '../db/prisma.js';
import type { Asset, AssetStatus, Prisma } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListAssetsParams extends PaginationParams {
  userId?: string;
  status?: AssetStatus;
  categoryId?: string;
  tag?: string;
  minRiskScore?: number;
  maxRiskScore?: number;
  search?: string;
  sort?: 'name' | 'createdAt' | 'updatedAt' | 'riskScore';
  order?: 'asc' | 'desc';
}

const assetDetailInclude = {
  category: true,
  assetTags: { include: { tag: true } },
  _count: { select: { accounts: true, events: true } },
} satisfies Prisma.AssetInclude;

export type AssetWithDetails = Prisma.AssetGetPayload<{ include: typeof assetDetailInclude }>;

function buildWhere(params: ListAssetsParams): Prisma.AssetWhereInput {
  const where: Prisma.AssetWhereInput = {};

  if (params.userId) where.userId = params.userId;
  if (params.status) where.status = params.status;
  if (params.categoryId) where.categoryId = params.categoryId;

  if (params.minRiskScore !== undefined || params.maxRiskScore !== undefined) {
    where.riskScore = {
      ...(params.minRiskScore !== undefined ? { gte: params.minRiskScore } : {}),
      ...(params.maxRiskScore !== undefined ? { lte: params.maxRiskScore } : {}),
    };
  }

  if (params.tag) {
    where.assetTags = { some: { tag: { name: params.tag } } };
  }

  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: 'insensitive' } },
      { displayName: { contains: params.search, mode: 'insensitive' } },
      { description: { contains: params.search, mode: 'insensitive' } },
      { accounts: { some: { provider: { contains: params.search, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

function buildOrderBy(params: ListAssetsParams): Prisma.AssetOrderByWithRelationInput {
  return { [params.sort ?? 'createdAt']: params.order ?? 'desc' };
}

class AssetRepository {
  async create(data: Prisma.AssetUncheckedCreateInput): Promise<Asset> {
    return prisma.asset.create({ data });
  }

  async findById(id: string): Promise<Asset | null> {
    return prisma.asset.findUnique({ where: { id } });
  }

  async findByIdWithDetails(id: string): Promise<AssetWithDetails | null> {
    return prisma.asset.findUnique({ where: { id }, include: assetDetailInclude });
  }

  async update(id: string, data: Prisma.AssetUncheckedUpdateInput): Promise<Asset | null> {
    try {
      return await prisma.asset.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<Asset | null> {
    try {
      return await prisma.asset.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListAssetsParams): Promise<PaginatedResult<Asset>> {
    const where = buildWhere(params);

    const [items, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy: buildOrderBy(params), ...toSkipTake(params) }),
      prisma.asset.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async findByUser(
    userId: string,
    params: Omit<ListAssetsParams, 'userId'>,
  ): Promise<PaginatedResult<Asset>> {
    return this.list({ ...params, userId });
  }
}

export const assetRepository = new AssetRepository();
