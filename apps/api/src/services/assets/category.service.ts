import {
  categoryRepository,
  type ListCategoriesParams,
} from '../../repositories/category.repository.js';
import { isUniqueConstraintViolation } from '../../db/prisma-errors.js';
import { CategoryAlreadyExistsError, CategoryNotFoundError } from './errors.js';
import { ForbiddenError } from '../auth/errors.js';
import type { Requester } from './ownership.js';
import type { AssetCategory } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface CreateCategoryInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
}

class CategoryService {
  async list(params: ListCategoriesParams): Promise<PaginatedResult<AssetCategory>> {
    return categoryRepository.list(params);
  }

  async getById(id: string): Promise<AssetCategory> {
    const category = await categoryRepository.findById(id);
    if (!category) {
      throw new CategoryNotFoundError(id);
    }
    return category;
  }

  // Categories are shared platform taxonomy, not user data — only admins
  // may create them, to keep the taxonomy curated rather than fragmented
  // by every user inventing their own categories.
  async create(requester: Requester, input: CreateCategoryInput): Promise<AssetCategory> {
    if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('Only administrators may create categories');
    }

    try {
      return await categoryRepository.create(input);
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new CategoryAlreadyExistsError(input.slug);
      }
      throw err;
    }
  }
}

export const categoryService = new CategoryService();
