import { policyRegistry } from './policy-registry.js';
import type { PolicyEvaluation } from './dto/policy-result.js';
import type { Resource, Finding } from '../../generated/prisma/client.js';

export interface PolicyEvaluationStats {
  policiesExecuted: number;
  resourcesEvaluated: number;
  durationMs: number;
}

export interface PolicyEngineResult {
  policyCode: string;
  evaluation: PolicyEvaluation;
}

export interface PolicyEvaluationOutput {
  resultsByResource: Map<string, PolicyEngineResult[]>;
  stats: PolicyEvaluationStats;
}

// Never branches on provider or resource type, and never touches the
// database — same separation as RuleEngine (Phase 6A): DB access and
// enabled/disabled state belong to PolicyService, not here. `enabledCodes`
// is a plain Set the caller resolved beforehand, so a disabled policy
// simply doesn't run this pass (no PolicyResult write, no event) without
// PolicyEngine needing to know what "enabled" means or where it's stored.
class PolicyEngine {
  evaluate(
    resources: Resource[],
    findingsByResource: Map<string, Finding[]>,
    enabledCodes: Set<string>,
  ): PolicyEvaluationOutput {
    const startedAt = Date.now();
    const resultsByResource = new Map<string, PolicyEngineResult[]>();
    let policiesExecuted = 0;

    for (const resource of resources) {
      const findings = findingsByResource.get(resource.id) ?? [];
      const applicablePolicies = policyRegistry
        .policiesFor(resource)
        .filter((policy) => enabledCodes.has(policy.id()));

      const results: PolicyEngineResult[] = [];
      for (const policy of applicablePolicies) {
        policiesExecuted += 1;
        results.push({ policyCode: policy.id(), evaluation: policy.evaluate(resource, findings) });
      }
      resultsByResource.set(resource.id, results);
    }

    return {
      resultsByResource,
      stats: {
        policiesExecuted,
        resourcesEvaluated: resources.length,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

export const policyEngine = new PolicyEngine();
