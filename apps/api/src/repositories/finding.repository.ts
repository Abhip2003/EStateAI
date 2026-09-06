import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Finding, FindingSeverity, FindingStatus } from '../generated/prisma/client.js';
import {
  toPaginatedResult,
  toSkipTake,
  type PaginatedResult,
  type PaginationParams,
} from './pagination.js';
import type { SeverityCounts } from '../services/analysis/dto/risk-score.js';

export interface CreateFindingInput {
  resourceId: string;
  provider: string;
  ruleCode: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  confidence?: number;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateFindingInput {
  severity?: FindingSeverity;
  status?: FindingStatus;
  title?: string;
  description?: string;
  confidence?: number;
  metadata?: Prisma.InputJsonValue;
  resolvedAt?: Date | null;
}

export interface ListFindingsParams extends PaginationParams {
  assetId?: string;
  accountId?: string;
  resourceId?: string;
  provider?: string;
  ruleCode?: string;
  severity?: FindingSeverity;
  status?: FindingStatus;
  search?: string;
  sort?: 'createdAt' | 'updatedAt' | 'severity';
  order?: 'asc' | 'desc';
}

class FindingRepository {
  async create(data: CreateFindingInput): Promise<Finding> {
    return prisma.finding.create({
      data: {
        resourceId: data.resourceId,
        provider: data.provider,
        ruleCode: data.ruleCode,
        severity: data.severity,
        title: data.title,
        description: data.description,
        confidence: data.confidence ?? 100,
        metadata: data.metadata,
      },
    });
  }

  async update(id: string, data: UpdateFindingInput): Promise<Finding | null> {
    try {
      return await prisma.finding.update({ where: { id }, data });
    } catch {
      return null;
    }
  }

  async findById(id: string): Promise<Finding | null> {
    return prisma.finding.findUnique({ where: { id } });
  }

  async findByResourceAndRule(resourceId: string, ruleCode: string): Promise<Finding | null> {
    return prisma.finding.findUnique({
      where: { resourceId_ruleCode: { resourceId, ruleCode } },
    });
  }

  // Every OPEN finding currently on a resource — FindingService diffs this
  // against a fresh rule-evaluation pass to decide which findings resolve.
  async findOpenByResource(resourceId: string): Promise<Finding[]> {
    return prisma.finding.findMany({ where: { resourceId, status: 'OPEN' } });
  }

  async findByResource(resourceId: string): Promise<Finding[]> {
    return prisma.finding.findMany({ where: { resourceId } });
  }

  async delete(id: string): Promise<Finding | null> {
    try {
      return await prisma.finding.delete({ where: { id } });
    } catch {
      return null;
    }
  }

  // Resource<->Finding, like Resource<->Relationship, has no formal FK — a
  // resourceId join needs a two-step query (resource ids resolved by the
  // caller first) rather than a Prisma relation filter. RiskService uses
  // this to aggregate ACCOUNT/ASSET-scope severity counts.
  async countOpenBySeverityForResourceIds(resourceIds: string[]): Promise<SeverityCounts> {
    if (resourceIds.length === 0) {
      return { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
    }
    const rows = await prisma.finding.groupBy({
      by: ['severity'],
      where: { resourceId: { in: resourceIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    return toSeverityCounts(rows);
  }

  async countOpenBySeverityAll(): Promise<SeverityCounts> {
    const rows = await prisma.finding.groupBy({
      by: ['severity'],
      where: { status: 'OPEN' },
      _count: { _all: true },
    });
    return toSeverityCounts(rows);
  }

  async list(params: ListFindingsParams): Promise<PaginatedResult<Finding>> {
    const resourceIds = await this.resolveScopedResourceIds(params);

    const where: Prisma.FindingWhereInput = {
      ...(params.resourceId ? { resourceId: params.resourceId } : {}),
      ...(resourceIds ? { resourceId: { in: resourceIds } } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.ruleCode ? { ruleCode: params.ruleCode } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.search
        ? {
            OR: [
              { title: { contains: params.search, mode: 'insensitive' } },
              { description: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.finding.findMany({
        where,
        orderBy: { [params.sort ?? 'createdAt']: params.order ?? 'desc' },
        ...toSkipTake(params),
      }),
      prisma.finding.count({ where }),
    ]);

    return toPaginatedResult(items, total, params);
  }

  // assetId/accountId filters have no column on Finding (soft-referenced
  // only via resourceId) — resolved through Resource the same two-step way
  // ResourceSearchService resolves a relationshipType filter.
  private async resolveScopedResourceIds(
    params: Pick<ListFindingsParams, 'assetId' | 'accountId'>,
  ): Promise<string[] | undefined> {
    if (!params.assetId && !params.accountId) {
      return undefined;
    }
    const resources = await prisma.resource.findMany({
      where: {
        ...(params.assetId ? { assetId: params.assetId } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
      },
      select: { id: true },
    });
    return resources.map((r) => r.id);
  }
}

function toSeverityCounts(
  rows: { severity: FindingSeverity; _count: { _all: number } }[],
): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  for (const row of rows) {
    switch (row.severity) {
      case 'CRITICAL':
        counts.critical = row._count._all;
        break;
      case 'HIGH':
        counts.high = row._count._all;
        break;
      case 'MEDIUM':
        counts.medium = row._count._all;
        break;
      case 'LOW':
        counts.low = row._count._all;
        break;
      case 'INFORMATIONAL':
        counts.informational = row._count._all;
        break;
    }
  }
  return counts;
}

export const findingRepository = new FindingRepository();
