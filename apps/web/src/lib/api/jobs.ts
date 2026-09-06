import { apiRequest } from './client';
import type { Job, JobStatus, PaginatedResult } from '../types';

export interface ListJobsParams {
  assetId?: string;
  accountId?: string;
  type?: string;
  status?: JobStatus;
  page?: number;
  limit?: number;
}

export const jobsApi = {
  list: (params: ListJobsParams) => apiRequest<PaginatedResult<Job>>('/jobs', { query: { ...params } }),

  get: (id: string) => apiRequest<Job>(`/jobs/${id}`),

  cancel: (id: string) => apiRequest<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),

  retry: (id: string) => apiRequest<Job>(`/jobs/${id}/retry`, { method: 'POST' }),
};
