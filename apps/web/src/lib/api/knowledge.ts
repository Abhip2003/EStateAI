import { apiRequest } from './client';
import type { KnowledgeContext } from '../types';

export const knowledgeApi = {
  buildContext: (assetId: string, focus?: string) =>
    apiRequest<KnowledgeContext>('/knowledge/context', { method: 'POST', body: { assetId, focus } }),

  listRetrievers: () => apiRequest<{ items: { id: string }[] }>('/knowledge/retrievers'),
};
