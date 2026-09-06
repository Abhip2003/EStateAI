import { apiRequest } from './client';
import type { AggregatedPlanResult, AIMode, RequestType } from '../types';

export interface ExecuteAgentInput {
  requestType: RequestType;
  assetId: string;
  aiMode?: AIMode;
}

export const agentsApi = {
  execute: (input: ExecuteAgentInput) =>
    apiRequest<AggregatedPlanResult>('/agents/execute', { method: 'POST', body: input }),
};
