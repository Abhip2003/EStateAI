import { apiRequest } from './client';
import type { Finding, FindingSeverity, FindingStatus, PaginatedResult, Recommendation, RiskScore } from '../types';

export interface ListFindingsParams {
  assetId: string;
  severity?: FindingSeverity;
  status?: FindingStatus;
  search?: string;
  page?: number;
  limit?: number;
  sort?: 'createdAt' | 'updatedAt' | 'severity';
  order?: 'asc' | 'desc';
}

export interface ListRecommendationsParams {
  assetId: string;
  status?: string;
  priority?: FindingSeverity;
  page?: number;
  limit?: number;
}

export const analysisApi = {
  listFindings: (params: ListFindingsParams) =>
    apiRequest<PaginatedResult<Finding>>('/analysis/findings', { query: { ...params } }),

  listRecommendations: (params: ListRecommendationsParams) =>
    apiRequest<PaginatedResult<Recommendation>>('/analysis/recommendations', { query: { ...params } }),

  riskForAsset: (assetId: string) =>
    apiRequest<{ risk: RiskScore | null }>(`/analysis/risk/assets/${assetId}`),

  // No assetId: admin-only, returns the platform-wide OVERALL-scope score.
  // Non-admin callers must pass assetId (equivalent to riskForAsset).
  riskOverview: () => apiRequest<{ risk: RiskScore | null }>('/analysis/risk'),
};
