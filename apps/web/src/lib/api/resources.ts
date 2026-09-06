import { apiRequest } from './client';
import type { PaginatedResult, Resource } from '../types';

export interface ListResourcesParams {
  assetId: string;
  provider?: string;
  resourceType?: string;
  name?: string;
  page?: number;
  limit?: number;
  sort?: 'displayName' | 'lastSeen' | 'firstSeen' | 'createdAt';
  order?: 'asc' | 'desc';
}

export const resourcesApi = {
  list: (params: ListResourcesParams) =>
    apiRequest<PaginatedResult<Resource>>('/resources', { query: { ...params } }),

  get: (id: string) => apiRequest<Resource>(`/resources/${id}`),

  neighbors: (id: string) => apiRequest<{ items: Resource[] }>(`/resources/${id}/neighbors`),
};
