import {
  assetRepository,
  type AssetWithDetails,
  type ListAssetsParams,
} from '../../repositories/asset.repository.js';
import { categoryRepository } from '../../repositories/category.repository.js';
import { AssetNotFoundError, CategoryNotFoundError, InvalidRiskScoreError } from './errors.js';
import { isOwnerOrAdmin, type Requester } from './ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import type { Asset, AssetStatus, Visibility } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface CreateAssetInput {
  categoryId: string;
  name: string;
  displayName?: string;
  description?: string;
  status?: AssetStatus;
  visibility?: Visibility;
  riskScore?: number;
}

export interface UpdateAssetInput {
  categoryId?: string;
  name?: string;
  displayName?: string | null;
  description?: string | null;
  status?: AssetStatus;
  visibility?: Visibility;
  riskScore?: number;
}

export type ListAssetsQuery = Omit<ListAssetsParams, 'userId'>;

function assertValidRiskScore(riskScore: number | undefined): void {
  if (riskScore !== undefined && (riskScore < 0 || riskScore > 100)) {
    throw new InvalidRiskScoreError(riskScore);
  }
}

async function assertCategoryExists(categoryId: string): Promise<void> {
  const category = await categoryRepository.findById(categoryId);
  if (!category) {
    throw new CategoryNotFoundError(categoryId);
  }
}

class AssetService {
  async create(requester: Requester, input: CreateAssetInput): Promise<Asset> {
    assertValidRiskScore(input.riskScore);
    await assertCategoryExists(input.categoryId);

    return assetRepository.create({
      userId: requester.id,
      categoryId: input.categoryId,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      status: input.status,
      visibility: input.visibility,
      riskScore: input.riskScore,
    });
  }

  async getById(id: string, requester: Requester): Promise<AssetWithDetails> {
    const asset = await assetRepository.findByIdWithDetails(id);
    if (!asset) {
      throw new AssetNotFoundError(id);
    }
    if (!isOwnerOrAdmin(asset, requester)) {
      throw new ForbiddenError('You do not have access to this asset');
    }
    return asset;
  }

  // Also backs GET /assets/search — search is just one more filter on the
  // same query, not a separate code path.
  async list(requester: Requester, params: ListAssetsQuery): Promise<PaginatedResult<Asset>> {
    if (requester.role === 'ADMIN') {
      return assetRepository.list(params);
    }
    return assetRepository.findByUser(requester.id, params);
  }

  async update(id: string, requester: Requester, input: UpdateAssetInput): Promise<Asset> {
    assertValidRiskScore(input.riskScore);

    const asset = await assetRepository.findById(id);
    if (!asset) {
      throw new AssetNotFoundError(id);
    }
    if (!isOwnerOrAdmin(asset, requester)) {
      throw new ForbiddenError('You do not have access to this asset');
    }

    if (input.categoryId !== undefined) {
      await assertCategoryExists(input.categoryId);
    }

    const updated = await assetRepository.update(id, input);
    if (!updated) {
      throw new AssetNotFoundError(id);
    }
    return updated;
  }

  // DELETE /assets/:id soft-archives rather than removing the row — an
  // asset's accounts/tags/event history stay intact and queryable. A real
  // hard delete is never exposed over HTTP; repositories still support it
  // directly for internal/test use.
  async archive(id: string, requester: Requester): Promise<Asset> {
    const asset = await assetRepository.findById(id);
    if (!asset) {
      throw new AssetNotFoundError(id);
    }
    if (!isOwnerOrAdmin(asset, requester)) {
      throw new ForbiddenError('You do not have access to this asset');
    }

    const archived = await assetRepository.update(id, { status: 'ARCHIVED' });
    if (!archived) {
      throw new AssetNotFoundError(id);
    }
    return archived;
  }
}

export const assetService = new AssetService();
