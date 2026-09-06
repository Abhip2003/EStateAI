import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import type { RiskScope, RiskScore } from '../generated/prisma/client.js';
import type { SeverityCounts } from '../services/analysis/dto/risk-score.js';

export interface UpsertRiskScoreInput {
  scope: RiskScope;
  assetId?: string;
  accountId?: string;
  provider?: string;
  resourceId?: string;
  overallScore: number;
  counts: SeverityCounts;
  metadata?: Prisma.InputJsonValue;
}

// scope + at most one of {resourceId, accountId, assetId} (none for
// OVERALL) uniquely identifies "the current row for this entity" — see the
// RiskScore model's schema comment for why this is enforced here rather
// than via a DB constraint.
export type RiskScopeKey =
  | { scope: 'RESOURCE'; resourceId: string }
  | { scope: 'ACCOUNT'; accountId: string }
  | { scope: 'ASSET'; assetId: string }
  | { scope: 'OVERALL' };

class RiskScoreRepository {
  async findByScope(key: RiskScopeKey): Promise<RiskScore | null> {
    return prisma.riskScore.findFirst({ where: scopeWhere(key) });
  }

  async deleteByScope(key: RiskScopeKey): Promise<void> {
    await prisma.riskScore.deleteMany({ where: scopeWhere(key) });
  }

  // Batch RESOURCE-scope lookup — used by ComplianceService to bucket a
  // report's resources into a risk distribution without one query per
  // resource.
  async findByResourceIds(resourceIds: string[]): Promise<RiskScore[]> {
    if (resourceIds.length === 0) {
      return [];
    }
    return prisma.riskScore.findMany({
      where: { scope: 'RESOURCE', resourceId: { in: resourceIds } },
    });
  }

  async upsert(data: UpsertRiskScoreInput): Promise<RiskScore> {
    const key = toScopeKey(data);
    const existing = await this.findByScope(key);

    const fields = {
      overallScore: data.overallScore,
      criticalCount: data.counts.critical,
      highCount: data.counts.high,
      mediumCount: data.counts.medium,
      lowCount: data.counts.low,
      informationalCount: data.counts.informational,
      metadata: data.metadata,
    };

    if (existing) {
      return prisma.riskScore.update({ where: { id: existing.id }, data: fields });
    }

    return prisma.riskScore.create({
      data: {
        scope: data.scope,
        assetId: data.assetId,
        accountId: data.accountId,
        provider: data.provider,
        resourceId: data.resourceId,
        ...fields,
      },
    });
  }
}

function toScopeKey(data: UpsertRiskScoreInput): RiskScopeKey {
  switch (data.scope) {
    case 'RESOURCE':
      return { scope: 'RESOURCE', resourceId: data.resourceId as string };
    case 'ACCOUNT':
      return { scope: 'ACCOUNT', accountId: data.accountId as string };
    case 'ASSET':
      return { scope: 'ASSET', assetId: data.assetId as string };
    case 'OVERALL':
      return { scope: 'OVERALL' };
  }
}

function scopeWhere(key: RiskScopeKey): Prisma.RiskScoreWhereInput {
  switch (key.scope) {
    case 'RESOURCE':
      return { scope: 'RESOURCE', resourceId: key.resourceId };
    case 'ACCOUNT':
      return { scope: 'ACCOUNT', accountId: key.accountId };
    case 'ASSET':
      return { scope: 'ASSET', assetId: key.assetId };
    case 'OVERALL':
      return { scope: 'OVERALL' };
  }
}

export const riskScoreRepository = new RiskScoreRepository();
