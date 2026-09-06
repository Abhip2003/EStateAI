import { policyRepository, type ListPoliciesParams } from '../../repositories/policy.repository.js';
import { policyResultRepository } from '../../repositories/policy-result.repository.js';
import { findingRepository } from '../../repositories/finding.repository.js';
import { eventService } from '../assets/event.service.js';
import type { Requester } from '../assets/ownership.js';
import { PolicyNotFoundError } from './policy-errors.js';
import { policyRegistry } from './policy-registry.js';
import { policyEngine } from './policy-engine.js';
import './policies/index.js';
import { Prisma, type Policy, type Resource, type Finding } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface EvaluatePoliciesInput {
  resources: Resource[];
  provider: string;
  assetId: string;
  requester: Requester;
}

export interface PolicyEvaluationSummary {
  policiesExecuted: number;
  resourcesEvaluated: number;
  passed: number;
  failed: number;
  warned: number;
  notApplicable: number;
  durationMs: number;
}

// Policies are an organizational catalog, not per-user data (unlike
// Asset/Resource/Finding) — every registered policy is visible to any
// authenticated user, the same way categories/tags are shared reference
// data rather than ownership-scoped.
class PolicyService {
  // Idempotent — safe to call on every evaluation run. Never touches
  // `enabled` on an existing row (see PolicyRepository.upsertDefinition).
  async ensureRegisteredPoliciesPersisted(): Promise<void> {
    for (const metadata of policyRegistry.allMetadata()) {
      await policyRepository.upsertDefinition(metadata);
    }
  }

  // Called by DiscoveryService right after FindingService — policies
  // consume each resource's current OPEN findings, never raw provider
  // data. Only ENABLED policies actually run and persist a PolicyResult;
  // POLICY_PASSED/POLICY_FAILED fire only when a result's status changed
  // (or is new), so an unchanged rerun stays quiet.
  async evaluateResources(input: EvaluatePoliciesInput): Promise<PolicyEvaluationSummary> {
    await this.ensureRegisteredPoliciesPersisted();
    const enabledCodes = new Set(await policyRepository.findEnabledCodes(input.provider));

    const findingsByResource = new Map<string, Finding[]>();
    for (const resource of input.resources) {
      findingsByResource.set(resource.id, await findingRepository.findOpenByResource(resource.id));
    }

    const { resultsByResource, stats } = policyEngine.evaluate(
      input.resources,
      findingsByResource,
      enabledCodes,
    );

    const summary: PolicyEvaluationSummary = {
      policiesExecuted: stats.policiesExecuted,
      resourcesEvaluated: stats.resourcesEvaluated,
      passed: 0,
      failed: 0,
      warned: 0,
      notApplicable: 0,
      durationMs: stats.durationMs,
    };

    for (const [resourceId, results] of resultsByResource) {
      for (const result of results) {
        const policy = await policyRepository.findByCode(result.policyCode);
        if (!policy) {
          continue;
        }

        const previous = await policyResultRepository.findByPolicyAndResource(
          policy.id,
          resourceId,
        );
        const saved = await policyResultRepository.upsert({
          policyId: policy.id,
          resourceId,
          findingId: result.evaluation.findingId,
          status: result.evaluation.status,
          reason: result.evaluation.reason,
          metadata: result.evaluation.metadata as Prisma.InputJsonValue | undefined,
        });

        this.tally(summary, saved.status);

        const statusChanged = previous?.status !== saved.status;
        if (statusChanged && saved.status === 'PASS') {
          await this.emitEvent(input.assetId, input.requester, 'POLICY_PASSED', policy, saved);
        } else if (statusChanged && saved.status === 'FAIL') {
          await this.emitEvent(input.assetId, input.requester, 'POLICY_FAILED', policy, saved);
        }
      }
    }

    return summary;
  }

  async list(_requester: Requester, params: ListPoliciesParams): Promise<PaginatedResult<Policy>> {
    return policyRepository.list(params);
  }

  async getById(id: string, _requester: Requester): Promise<Policy> {
    const policy = await policyRepository.findById(id);
    if (!policy) {
      throw new PolicyNotFoundError(id);
    }
    return policy;
  }

  private tally(summary: PolicyEvaluationSummary, status: string): void {
    if (status === 'PASS') summary.passed += 1;
    else if (status === 'FAIL') summary.failed += 1;
    else if (status === 'WARNING') summary.warned += 1;
    else if (status === 'NOT_APPLICABLE') summary.notApplicable += 1;
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    type: string,
    policy: Policy,
    result: { id: string; resourceId: string; status: string; reason: string },
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type,
        severity: type === 'POLICY_FAILED' ? 'WARNING' : 'INFO',
        title: `${type} — ${policy.name}`,
        metadata: {
          policyResultId: result.id,
          policyId: policy.id,
          policyCode: policy.code,
          resourceId: result.resourceId,
          status: result.status,
          reason: result.reason,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const policyService = new PolicyService();
