import { apiRequest } from './client';
import type { ComplianceReport, PaginatedResult, Policy } from '../types';

export interface ListPoliciesParams {
  page?: number;
  limit?: number;
  provider?: string;
  enabled?: boolean;
  severity?: string;
  search?: string;
}

export const policiesApi = {
  list: (params: ListPoliciesParams = {}) =>
    apiRequest<PaginatedResult<Policy>>('/policies', { query: { ...params } }),

  complianceForAsset: (assetId: string) =>
    apiRequest<ComplianceReport>(`/compliance/assets/${assetId}`),
};
