import type { Requester } from '../../assets/ownership.js';

// What every retriever and KnowledgeService receive. `focus` is a hint
// about what the context is being gathered for (e.g. 'risk', 'compliance',
// 'general') — reserved for a future retriever that only applies to a
// specific focus; today's 6 retrievers all apply regardless of it.
export interface RetrievalRequest {
  assetId: string;
  accountId?: string;
  focus?: string;
  requester: Requester;
}
