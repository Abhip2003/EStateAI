import {
  resourceRepository,
  type ListResourcesParams,
} from '../../repositories/resource.repository.js';
import { relationshipRepository } from '../../repositories/relationship.repository.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import type { Resource } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export type SearchResourcesQuery = ListResourcesParams & { relationshipType?: string };

class ResourceSearchService {
  // Mirrors AccountService.list / JobService.listJobs: non-admins must
  // scope by a specific asset they own, ADMIN can search across everything.
  async search(
    requester: Requester,
    params: SearchResourcesQuery,
  ): Promise<PaginatedResult<Resource>> {
    if (params.assetId) {
      await getOwnedAsset(params.assetId, requester);
    } else if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to search resources');
    }

    let ids: string[] | undefined;
    if (params.relationshipType) {
      // No formal Resource<->Relationship FK (see relationship.repository.ts),
      // so the relationship filter is a two-step query: resolve matching
      // edges first, then constrain the resource search to the resource
      // ids on either end of them.
      const edges = await relationshipRepository.findByType(params.relationshipType);
      ids = [...new Set(edges.flatMap((edge) => [edge.fromResourceId, edge.toResourceId]))];
      if (ids.length === 0) {
        return { items: [], total: 0, page: params.page, limit: params.limit, totalPages: 1 };
      }
    }

    return resourceRepository.list({ ...params, ids });
  }
}

export const resourceSearchService = new ResourceSearchService();
