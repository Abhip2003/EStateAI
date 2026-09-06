import { tagRepository, type ListTagsParams } from '../../repositories/tag.repository.js';
import { isUniqueConstraintViolation } from '../../db/prisma-errors.js';
import { TagAlreadyExistsError, TagNotFoundError } from './errors.js';
import { getOwnedAsset, type Requester } from './ownership.js';
import type { Tag } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface CreateTagInput {
  name: string;
  color?: string;
}

class TagService {
  async list(params: ListTagsParams): Promise<PaginatedResult<Tag>> {
    return tagRepository.list(params);
  }

  // Unlike categories, tags are lightweight and user-driven — any
  // authenticated user may create one, no admin gate.
  async create(input: CreateTagInput): Promise<Tag> {
    try {
      return await tagRepository.create(input);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new TagAlreadyExistsError(input.name);
      }
      throw err;
    }
  }

  async attachToAsset(assetId: string, tagId: string, requester: Requester): Promise<void> {
    await getOwnedAsset(assetId, requester);

    const tag = await tagRepository.findById(tagId);
    if (!tag) {
      throw new TagNotFoundError(tagId);
    }

    await tagRepository.attachToAsset(assetId, tagId);
  }

  async detachFromAsset(assetId: string, tagId: string, requester: Requester): Promise<void> {
    await getOwnedAsset(assetId, requester);
    await tagRepository.detachFromAsset(assetId, tagId);
  }

  async listForAsset(assetId: string, requester: Requester): Promise<Tag[]> {
    await getOwnedAsset(assetId, requester);
    return tagRepository.findTagsForAsset(assetId);
  }
}

export const tagService = new TagService();
