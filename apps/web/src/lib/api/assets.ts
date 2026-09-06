import { apiRequest } from './client';
import type { Asset, AssetCategory, AssetDetail, AssetEvent, PaginatedResult } from '../types';

export interface ListAssetsParams {
  page?: number;
  limit?: number;
  status?: string;
  categoryId?: string;
  search?: string;
  sort?: 'name' | 'createdAt' | 'updatedAt' | 'riskScore';
  order?: 'asc' | 'desc';
}

export interface CreateAssetInput {
  categoryId: string;
  name: string;
  displayName?: string;
  description?: string;
}

export const assetsApi = {
  list: (params: ListAssetsParams = {}) =>
    apiRequest<PaginatedResult<Asset>>('/assets', { query: { ...params } }),

  get: (id: string) => apiRequest<AssetDetail>(`/assets/${id}`),

  create: (input: CreateAssetInput) =>
    apiRequest<Asset>('/assets', { method: 'POST', body: input }),

  archive: (id: string) => apiRequest<Asset>(`/assets/${id}`, { method: 'DELETE' }),

  listEvents: (assetId: string, params: { page?: number; limit?: number } = {}) =>
    apiRequest<PaginatedResult<AssetEvent>>(`/assets/${assetId}/events`, { query: { ...params } }),

  listCategories: (params: { page?: number; limit?: number } = {}) =>
    apiRequest<PaginatedResult<AssetCategory>>('/categories', { query: { ...params } }),
};
