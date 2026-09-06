import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { FindingSeverity, Policy } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';
import type { PolicyMetadata } from '../services/policy/dto/policy.js';

export interface ListPoliciesParams extends PaginationParams {
  provider?: string;
  enabled?: boolean;
  severity?: FindingSeverity;
  search?: string;
}

class PolicyRepository {
  // Called by PolicyService.ensureRegisteredPoliciesPersisted() for every
  // code-registered policy on each evaluation run. Deliberately does NOT
  // touch `enabled` on update — that field is DB-owned, never reset by a
  // metadata sync (see the Policy model's schema comment).
  async upsertDefinition(metadata: PolicyMetadata): Promise<Policy> {
    return prisma.policy.upsert({
      where: { code: metadata.code },
      create: {
        code: metadata.code,
        name: metadata.name,
        description: metadata.description,
        provider: metadata.provider,
        resourceType: metadata.resourceType,
        severity: metadata.severity,
        conditions: metadata.conditions as Prisma.InputJsonValue | undefined,
      },
      update: {
        name: metadata.name,
        description: metadata.description,
        provider: metadata.provider,
        resourceType: metadata.resourceType,
        severity: metadata.severity,
        conditions: metadata.conditions as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async findById(id: string): Promise<Policy | null> {
    return prisma.policy.findUnique({ where: { id } });
  }

  async findByCode(code: string): Promise<Policy | null> {
    return prisma.policy.findUnique({ where: { code } });
  }

  // Codes of every enabled policy, optionally scoped to a provider —
  // PolicyEngine only ever runs policies whose code appears in this set.
  async findEnabledCodes(provider?: string): Promise<string[]> {
    const rows = await prisma.policy.findMany({
      where: { enabled: true, ...(provider ? { provider } : {}) },
      select: { code: true },
    });
    return rows.map((r) => r.code);
  }

  async findByIds(ids: string[]): Promise<Policy[]> {
    if (ids.length === 0) {
      return [];
    }
    return prisma.policy.findMany({ where: { id: { in: ids } } });
  }

  async update(id: string, data: { enabled?: boolean }): Promise<Policy | null> {
    try {
      return await prisma.policy.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async list(params: ListPoliciesParams): Promise<PaginatedResult<Policy>> {
    const where: Prisma.PolicyWhereInput = {
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.search
        ? {
            OR: [
              { name: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.policy.findMany({
        where,
        orderBy: { name: 'asc' },
        ...toSkipTake(params),
      }),
      prisma.policy.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }
}

export const policyRepository = new PolicyRepository();
