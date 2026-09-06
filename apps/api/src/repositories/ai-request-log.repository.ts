import { prisma } from '../db/prisma.js';
import type { AIRequestLog, AIRequestStatus } from '../generated/prisma/client.js';

export interface CreateAIRequestLogInput {
  provider: string;
  model: string;
  assetId?: string;
  status: AIRequestStatus;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  attempts: number;
  error?: string;
}

class AIRequestLogRepository {
  // Write-once — created after the call settles (success or exhausted
  // retries), never updated afterward, unlike AgentPlanExecution's
  // start/complete pair.
  async create(data: CreateAIRequestLogInput): Promise<AIRequestLog> {
    return prisma.aIRequestLog.create({ data });
  }

  async findById(id: string): Promise<AIRequestLog | null> {
    return prisma.aIRequestLog.findUnique({ where: { id } });
  }

  async delete(id: string): Promise<void> {
    await prisma.aIRequestLog.delete({ where: { id } });
  }
}

export const aiRequestLogRepository = new AIRequestLogRepository();
