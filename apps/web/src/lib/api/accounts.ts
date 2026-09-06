import { apiRequest } from './client';
import type { Account, EnqueuedJob, PaginatedResult } from '../types';

export interface ConnectAccountInput {
  assetId: string;
  provider: string;
  credential?: string;
  displayName?: string;
}

export const accountsApi = {
  list: (params: { assetId?: string; page?: number; limit?: number } = {}) =>
    apiRequest<PaginatedResult<Account>>('/accounts', { query: { ...params } }),

  connect: (input: ConnectAccountInput) =>
    apiRequest<Account>('/accounts/connect', { method: 'POST', body: input }),

  sync: (accountId: string) =>
    apiRequest<EnqueuedJob>(`/accounts/${accountId}/sync`, { method: 'POST' }),

  discover: (accountId: string) =>
    apiRequest<EnqueuedJob>(`/accounts/${accountId}/discover`, { method: 'POST' }),

  disconnect: (accountId: string) =>
    apiRequest<Account>(`/accounts/${accountId}`, { method: 'DELETE' }),
};
