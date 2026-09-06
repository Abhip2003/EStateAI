import { assetRepository } from '../../repositories/asset.repository.js';
import { AssetNotFoundError } from './errors.js';
import { ForbiddenError } from '../auth/errors.js';
import type { SafeUser } from '../auth/safe-user.js';
import type { Asset } from '../../generated/prisma/client.js';

export type Requester = Pick<SafeUser, 'id' | 'role'>;

export function isOwnerOrAdmin(asset: Pick<Asset, 'userId'>, requester: Requester): boolean {
  return requester.role === 'ADMIN' || asset.userId === requester.id;
}

// Fetches an asset and enforces ownership in one step — used by
// EventService and TagService, which only need to confirm access to the
// parent asset before acting on its events/tags, not the full detail view
// AssetService.getById returns.
export async function getOwnedAsset(assetId: string, requester: Requester): Promise<Asset> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw new AssetNotFoundError(assetId);
  }
  if (!isOwnerOrAdmin(asset, requester)) {
    throw new ForbiddenError('You do not have access to this asset');
  }
  return asset;
}
