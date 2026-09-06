import { resourceRepository } from '../../repositories/resource.repository.js';
import { findingRepository } from '../../repositories/finding.repository.js';
import { policyResultRepository } from '../../repositories/policy-result.repository.js';
import { policyRepository } from '../../repositories/policy.repository.js';
import { riskScoreRepository } from '../../repositories/risk-score.repository.js';

// Assembles the "verified context bundle" the Python AI service's
// security-sensitive agents (risk/compliance/recommendation/report)
// consume. This is the trust boundary: deterministic TypeScript remains
// the source of truth for findings, severities, scores and policy
// results — the Python LLM agents only ever see what this function
// produced from the real database rows. They cannot invent findings
// because they are never given raw access to anything else.
//
// No new business logic here — every value is read straight from an
// existing repository, in the same shapes RiskService/ComplianceService
// already use.

export interface DiscoveryVerifiedBundle {
  provider: string;
  accountId: string;
  resources: Array<{
    id: string;
    provider: string;
    providerResourceId: string;
    resourceType: string;
    displayName: string;
    description?: string;
    externalUrl?: string;
    metadata: Record<string, unknown>;
  }>;
}

export interface RiskVerifiedBundle {
  assetId: string;
  findings: Array<Record<string, unknown>>;
  riskScore: Record<string, unknown> | null;
}

export interface ComplianceVerifiedBundle {
  assetId: string;
  policyResults: Array<Record<string, unknown>>;
}

export async function buildDiscoveryBundle(
  accountId: string,
): Promise<DiscoveryVerifiedBundle> {
  const resources = await resourceRepository.findActiveByAccount(accountId);
  return {
    provider: resources[0]?.provider ?? 'unknown',
    accountId,
    resources: resources.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerResourceId: r.providerResourceId,
      resourceType: r.resourceType,
      displayName: r.displayName,
      description: r.description ?? undefined,
      externalUrl: r.externalUrl ?? undefined,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    })),
  };
}

export async function buildRiskBundle(assetId: string): Promise<RiskVerifiedBundle> {
  const resources = await resourceRepository.findActiveByAsset(assetId);
  const findingsByResource = await Promise.all(
    resources.map((r) => findingRepository.findByResource(r.id)),
  );
  const findings = findingsByResource.flat();
  const providerByResource = new Map(resources.map((r) => [r.id, r.provider]));

  const riskScore = await riskScoreRepository.findByScope({ scope: 'ASSET', assetId });

  return {
    assetId,
    findings: findings.map((f) => ({
      id: f.id,
      resourceId: f.resourceId,
      provider: providerByResource.get(f.resourceId) ?? f.provider,
      ruleCode: f.ruleCode,
      severity: f.severity,
      status: f.status,
      title: f.title,
      description: f.description,
      confidence: f.confidence,
      metadata: (f.metadata as Record<string, unknown>) ?? {},
      createdAt: f.createdAt.toISOString(),
    })),
    riskScore: riskScore
      ? {
          overallScore: riskScore.overallScore,
          criticalCount: riskScore.criticalCount,
          highCount: riskScore.highCount,
          mediumCount: riskScore.mediumCount,
          lowCount: riskScore.lowCount,
          informationalCount: riskScore.informationalCount,
        }
      : null,
  };
}

export async function buildComplianceBundle(
  assetId: string,
): Promise<ComplianceVerifiedBundle> {
  const resources = await resourceRepository.findActiveByAsset(assetId);
  const resourceIds = resources.map((r) => r.id);
  const results = await policyResultRepository.findByResourceIds(resourceIds);
  const policyIds = [...new Set(results.map((r) => r.policyId))];
  const policies = await policyRepository.findByIds(policyIds);
  const policyById = new Map(policies.map((p) => [p.id, p]));

  return {
    assetId,
    policyResults: results.map((r) => {
      const policy = policyById.get(r.policyId);
      return {
        policyId: r.policyId,
        policyCode: policy?.code ?? r.policyId,
        policyName: policy?.name ?? '',
        framework:
          (policy?.conditions as { framework?: string } | null)?.framework ??
          policy?.provider?.toUpperCase() ??
          'GENERAL',
        resourceId: r.resourceId,
        status: r.status,
        severity: policy?.severity ?? 'MEDIUM',
        reason: r.reason,
        findingId: r.findingId ?? null,
      };
    }),
  };
}
