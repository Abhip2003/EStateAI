import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PolicyResult, PolicyResultStatus } from '../generated/prisma/client.js';

export interface UpsertPolicyResultInput {
  policyId: string;
  resourceId: string;
  findingId?: string;
  status: PolicyResultStatus;
  reason: string;
  metadata?: Prisma.InputJsonValue;
}

class PolicyResultRepository {
  // One row per (policyId, resourceId) — re-evaluation upserts in place,
  // same idempotency shape as Finding's (resourceId, ruleCode) uniqueness.
  async upsert(data: UpsertPolicyResultInput): Promise<PolicyResult> {
    const now = new Date();
    return prisma.policyResult.upsert({
      where: { policyId_resourceId: { policyId: data.policyId, resourceId: data.resourceId } },
      create: {
        policyId: data.policyId,
        resourceId: data.resourceId,
        findingId: data.findingId,
        status: data.status,
        reason: data.reason,
        metadata: data.metadata,
        evaluatedAt: now,
      },
      update: {
        findingId: data.findingId,
        status: data.status,
        reason: data.reason,
        metadata: data.metadata,
        evaluatedAt: now,
      },
    });
  }

  async findByPolicyAndResource(
    policyId: string,
    resourceId: string,
  ): Promise<PolicyResult | null> {
    return prisma.policyResult.findUnique({
      where: { policyId_resourceId: { policyId, resourceId } },
    });
  }

  async findByResource(resourceId: string): Promise<PolicyResult[]> {
    return prisma.policyResult.findMany({ where: { resourceId } });
  }

  // No formal PolicyResult<->Resource FK — same two-step pattern used
  // throughout the analysis/graph modules. ComplianceService resolves
  // resourceIds for a scope first, then calls this.
  async findByResourceIds(resourceIds: string[]): Promise<PolicyResult[]> {
    if (resourceIds.length === 0) {
      return [];
    }
    return prisma.policyResult.findMany({ where: { resourceId: { in: resourceIds } } });
  }

  async delete(id: string): Promise<PolicyResult | null> {
    try {
      return await prisma.policyResult.delete({ where: { id } });
    } catch {
      return null;
    }
  }
}

export const policyResultRepository = new PolicyResultRepository();
