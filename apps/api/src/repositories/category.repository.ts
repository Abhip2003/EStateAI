import { prisma } from '../db/prisma.js';
import type { AssetCategory, Prisma } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListCategoriesParams extends PaginationParams {
  search?: string;
}

// Categories are global reference/taxonomy data (not owned by a user), so
// there is no findByUser here — unlike Asset, AssetCategory has no userId.
class CategoryRepository {
  async create(data: Prisma.AssetCategoryCreateInput): Promise<AssetCategory> {
    return prisma.assetCategory.create({ data });
  }

  async findById(id: string): Promise<AssetCategory | null> {
    return prisma.assetCategory.findUnique({ where: { id } });
  }

  async findBySlug(slug: string): Promise<AssetCategory | null> {
    return prisma.assetCategory.findUnique({ where: { slug } });
  }

  async update(id: string, data: Prisma.AssetCategoryUpdateInput): Promise<AssetCategory | null> {
    try {
      return await prisma.assetCategory.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<AssetCategory | null> {
    try {
      return await prisma.assetCategory.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListCategoriesParams): Promise<PaginatedResult<AssetCategory>> {
    const where: Prisma.AssetCategoryWhereInput = params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' } },
            { description: { contains: params.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      prisma.assetCategory.findMany({ where, orderBy: { name: 'asc' }, ...toSkipTake(params) }),
      prisma.assetCategory.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }
}

export const categoryRepository = new CategoryRepository();
