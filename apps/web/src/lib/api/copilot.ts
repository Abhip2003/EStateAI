import { apiRequest } from './client';
import type { CopilotChatResult } from '../types';

export const copilotApi = {
  chat: (assetId: string, message: string) =>
    apiRequest<CopilotChatResult>('/copilot/chat', { method: 'POST', body: { assetId, message } }),
};
