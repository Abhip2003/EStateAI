import { resourceRepository } from '../../repositories/resource.repository.js';
import { policyResultRepository } from '../../repositories/policy-result.repository.js';
import { policyRepository } from '../../repositories/policy.repository.js';
import { findingRepository } from '../../repositories/finding.repository.js';
import { riskScoreRepository } from '../../repositories/risk-score.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { getOwnedAccount } from '../assets/account.service.js';
import { ForbiddenError } from '../auth/errors.js';
import type {
  ComplianceReport,
  ComplianceScope,
  PolicyOutcome,
  RiskDistribution,
} from './dto/compliance-report.js';
import type { PolicyResult, Resource } from '../../generated/prisma/client.js';

// overallScore is a capped weighted sum in RiskScore (see RiskService) —
// these bucket boundaries just group that 0-100 score into four bands for
// a report, not a separate scoring formula.
function riskBand(overallScore: number): keyof RiskDistribution {
  if (overallScore >= 75) return 'critical';
  if (overallScore >= 50) return 'high';
  if (overallScore >= 25) return 'medium';
  return 'low';
}

class ComplianceService {
  async getForAsset(assetId: string, requester: Requester): Promise<ComplianceReport> {
    await getOwnedAsset(assetId, requester);
    const resources = await resourceRepository.findActiveByAsset(assetId);
    return this.buildReport('ASSET', resources);
  }

  async getForAccount(accountId: string, requester: Requester): Promise<ComplianceReport> {
    const account = await getOwnedAccount(accountId, requester);
    const resources = await resourceRepository.findActiveByAccount(account.id);
    return this.buildReport('ACCOUNT', resources);
  }

  async getForProvider(provider: string, requester: Requester): Promise<ComplianceReport> {
    if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('Only administrators can view provider-wide compliance');
    }
    const resources = await resourceRepository.findActiveByProvider(provider);
    return this.buildReport('PROVIDER', resources);
  }

  async getOverview(
    requester: Requester,
    params: { assetId?: string; provider?: string },
  ): Promise<ComplianceReport> {
    if (params.assetId) {
      return this.getForAsset(params.assetId, requester);
    }
    if (params.provider) {
      return this.getForProvider(params.provider, requester);
    }
    if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to view compliance');
    }
    const resources = await resourceRepository.findAllActive();
    return this.buildReport('OVERALL', resources);
  }

  // Called by DiscoveryService right after PolicyService.evaluateResources
  // — recomputes the asset's report fresh (query-time, no persisted
  // snapshot — see ComplianceReport's doc comment) and emits one
  // COMPLIANCE_UPDATED event carrying it.
  async recalculateAndNotify(assetId: string, requester: Requester): Promise<void> {
    const resources = await resourceRepository.findActiveByAsset(assetId);
    const report = await this.buildReport('ASSET', resources);
    await this.emitEvent(assetId, requester, report);
  }

  private async buildReport(
    scope: ComplianceScope,
    resources: Resource[],
  ): Promise<ComplianceReport> {
    const resourceIds = resources.map((r) => r.id);
    const results = await policyResultRepository.findByResourceIds(resourceIds);

    const policyIds = [...new Set(results.map((r) => r.policyId))];
    const policies = await policyRepository.findByIds(policyIds);
    const policyById = new Map(policies.map((p) => [p.id, p]));

    let passCount = 0;
    let failCount = 0;
    let warningCount = 0;
    let notApplicableCount = 0;
    const policyFailures: PolicyOutcome[] = [];
    const policyPasses: PolicyOutcome[] = [];

    for (const result of results) {
      if (result.status === 'PASS') passCount += 1;
      else if (result.status === 'FAIL') failCount += 1;
      else if (result.status === 'WARNING') warningCount += 1;
      else notApplicableCount += 1;

      const outcome = toOutcome(result, policyById);
      if (result.status === 'FAIL' && outcome) policyFailures.push(outcome);
      if (result.status === 'PASS' && outcome) policyPasses.push(outcome);
    }

    const applicable = passCount + failCount + warningCount;
    // WARNING counts as half-credit — a permitted-but-flagged state is
    // neither a full pass nor a violation. NOT_APPLICABLE is excluded from
    // the denominator entirely (a policy that doesn't apply can't move the
    // score). Vacuously 100 when nothing applicable was evaluated.
    const complianceScore =
      applicable === 0 ? 100 : Math.round((100 * (passCount + warningCount * 0.5)) / applicable);

    const severityDistribution =
      await findingRepository.countOpenBySeverityForResourceIds(resourceIds);
    const riskDistribution = await this.buildRiskDistribution(resourceIds);

    return {
      scope,
      passCount,
      failCount,
      warningCount,
      notApplicableCount,
      complianceScore,
      policyFailures,
      policyPasses,
      severityDistribution,
      riskDistribution,
    };
  }

  private async buildRiskDistribution(resourceIds: string[]): Promise<RiskDistribution> {
    const scores = await riskScoreRepository.findByResourceIds(resourceIds);
    const distribution: RiskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const score of scores) {
      distribution[riskBand(score.overallScore)] += 1;
    }
    return distribution;
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    report: ComplianceReport,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type: 'COMPLIANCE_UPDATED',
        severity: 'INFO',
        title: `Compliance updated — score ${report.complianceScore}`,
        metadata: {
          assetId,
          complianceScore: report.complianceScore,
          passCount: report.passCount,
          failCount: report.failCount,
          warningCount: report.warningCount,
          notApplicableCount: report.notApplicableCount,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

function toOutcome(
  result: PolicyResult,
  policyById: Map<string, { code: string; name: string }>,
): PolicyOutcome | null {
  const policy = policyById.get(result.policyId);
  if (!policy) {
    return null;
  }
  return {
    policyCode: policy.code,
    policyName: policy.name,
    resourceId: result.resourceId,
    reason: result.reason,
  };
}

export const complianceService = new ComplianceService();
