import type { Requester } from '../../assets/ownership.js';

export interface CopilotChatInput {
  assetId: string;
  message: string;
  requester: Requester;
}

export const CopilotChatStatus = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export type CopilotChatStatus = (typeof CopilotChatStatus)[keyof typeof CopilotChatStatus];

export interface CopilotChatMetadata {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  generatedAt: string;
}

// What POST /copilot/chat returns. On AI failure, `status` is FAILED and
// `answer`/`citations`/`metadata` are simply absent — the request itself
// still succeeds (200), same graceful-degradation shape ReportAgent's
// AIReport uses (Phase 7D).
export interface CopilotChatResult {
  status: CopilotChatStatus;
  answer?: string;
  citations?: string[];
  metadata?: CopilotChatMetadata;
  error?: string;
}
