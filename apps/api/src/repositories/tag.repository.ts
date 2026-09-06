import { prisma } from '../db/prisma.js';
import type { Prisma, Tag } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';

export interface ListTagsParams extends PaginationParams {
  search?: string;
}

// Tags are global (like AssetCategory), so there is no findByUser here. The
// Asset<->Tag many-to-many association itself (attach/detach) lives here
// too, since it's tag-management surface area, not asset-management.
class TagRepository {
  async create(data: Prisma.TagCreateInput): Promise<Tag> {
    return prisma.tag.create({ data });
  }

  async findById(id: string): Promise<Tag | null> {
    return prisma.tag.findUnique({ where: { id } });
  }

  async findByName(name: string): Promise<Tag | null> {
    return prisma.tag.findUnique({ where: { name } });
  }

  async update(id: string, data: Prisma.TagUpdateInput): Promise<Tag | null> {
    try {
      return await prisma.tag.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<Tag | null> {
    try {
      return await prisma.tag.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  async list(params: ListTagsParams): Promise<PaginatedResult<Tag>> {
    const where: Prisma.TagWhereInput = params.search
      ? { name: { contains: params.search, mode: 'insensitive' } }
      : {};

    const [items, total] = await Promise.all([
      prisma.tag.findMany({ where, orderBy: { name: 'asc' }, ...toSkipTake(params) }),
      prisma.tag.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  async attachToAsset(assetId: string, tagId: string): Promise<void> {
    await prisma.assetTag.upsert({
      where: { assetId_tagId: { assetId, tagId } },
      create: { assetId, tagId },
      update: {},
    });
  }

  async detachFromAsset(assetId: string, tagId: string): Promise<void> {
    await prisma.assetTag.deleteMany({ where: { assetId, tagId } });
  }

  async findTagsForAsset(assetId: string): Promise<Tag[]> {
    const assetTags = await prisma.assetTag.findMany({
      where: { assetId },
      include: { tag: true },
      orderBy: { tag: { name: 'asc' } },
    });
    return assetTags.map((assetTag) => assetTag.tag);
  }
}

export const tagRepository = new TagRepository();
