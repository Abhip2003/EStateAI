import { findingRepository } from '../../repositories/finding.repository.js';
import { resourceRepository } from '../../repositories/resource.repository.js';
import { riskScoreRepository } from '../../repositories/risk-score.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { getOwnedAccount } from '../assets/account.service.js';
import { ForbiddenError } from '../auth/errors.js';
import { config } from '../../config/env.js';
import type { SeverityCounts } from './dto/risk-score.js';
import type { RiskScore } from '../../generated/prisma/client.js';

export interface RecalculateRiskInput {
  resourceIds: string[];
  accountId: string;
  assetId: string;
}

// overallScore is a capped weighted sum, not an average — every additional
// OPEN finding should raise risk (never dilute it the way an average
// would), capped at 100 since it's presented as a percentage-like score.
// Weights are configurable via RISK_WEIGHT_* env vars (config.risk.weights).
function computeScore(counts: SeverityCounts): number {
  const weights = config.risk.weights;
  const raw =
    counts.critical * weights.CRITICAL +
    counts.high * weights.HIGH +
    counts.medium * weights.MEDIUM +
    counts.low * weights.LOW +
    counts.informational * weights.INFORMATIONAL;
  return Math.min(100, raw);
}

class RiskService {
  // Called by DiscoveryService after finding evaluation, for every scope
  // touched by this run: each individual resource, the discovering
  // account, the owning asset, and the platform-wide OVERALL total.
  async recalculate(input: RecalculateRiskInput, requester: Requester): Promise<void> {
    for (const resourceId of input.resourceIds) {
      const counts = await findingRepository.countOpenBySeverityForResourceIds([resourceId]);
      await riskScoreRepository.upsert({
        scope: 'RESOURCE',
        resourceId,
        overallScore: computeScore(counts),
        counts,
      });
    }

    const accountResources = await resourceRepository.findActiveByAccount(input.accountId);
    const accountCounts = await findingRepository.countOpenBySeverityForResourceIds(
      accountResources.map((r) => r.id),
    );
    await riskScoreRepository.upsert({
      scope: 'ACCOUNT',
      accountId: input.accountId,
      overallScore: computeScore(accountCounts),
      counts: accountCounts,
    });

    const assetResources = await resourceRepository.findActiveByAsset(input.assetId);
    const assetCounts = await findingRepository.countOpenBySeverityForResourceIds(
      assetResources.map((r) => r.id),
    );
    const assetScore = await riskScoreRepository.upsert({
      scope: 'ASSET',
      assetId: input.assetId,
      overallScore: computeScore(assetCounts),
      counts: assetCounts,
    });

    const overallCounts = await findingRepository.countOpenBySeverityAll();
    await riskScoreRepository.upsert({
      scope: 'OVERALL',
      overallScore: computeScore(overallCounts),
      counts: overallCounts,
    });

    await this.emitEvent(input.assetId, requester, assetScore);
  }

  async getForAsset(assetId: string, requester: Requester): Promise<RiskScore | null> {
    await getOwnedAsset(assetId, requester);
    return riskScoreRepository.findByScope({ scope: 'ASSET', assetId });
  }

  async getForAccount(accountId: string, requester: Requester): Promise<RiskScore | null> {
    const account = await getOwnedAccount(accountId, requester);
    return riskScoreRepository.findByScope({ scope: 'ACCOUNT', accountId: account.id });
  }

  // Non-admins must scope to a specific asset (mirrors every other
  // non-admin list endpoint in this codebase); only an ADMIN can see the
  // platform-wide OVERALL row.
  async getOverview(requester: Requester, assetId?: string): Promise<RiskScore | null> {
    if (assetId) {
      return this.getForAsset(assetId, requester);
    }
    if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to view risk');
    }
    return riskScoreRepository.findByScope({ scope: 'OVERALL' });
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    assetScore: RiskScore,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type: 'RISK_UPDATED',
        severity: 'INFO',
        title: `Risk updated — overall score ${assetScore.overallScore}`,
        metadata: {
          assetId,
          overallScore: assetScore.overallScore,
          criticalCount: assetScore.criticalCount,
          highCount: assetScore.highCount,
          mediumCount: assetScore.mediumCount,
          lowCount: assetScore.lowCount,
          informationalCount: assetScore.informationalCount,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const riskService = new RiskService();
