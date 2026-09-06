import type { Resource, Finding } from '../../generated/prisma/client.js';
import type { PolicyEvaluation } from './dto/policy-result.js';
import type { PolicyMetadata } from './dto/policy.js';

// Policies consume Findings, not raw provider responses — evaluate()
// receives the resource's current OPEN findings alongside the resource
// itself. A policy MAY still read resource.metadata directly (the same way
// a Rule does) when the question isn't "did a rule flag a problem" but
// "does this resource's shape even apply here" (e.g. excluding forks) —
// what PolicyEngine itself never does is know that GitHub, or any
// provider, exists.
export interface Policy {
  id(): string;
  supports(resource: Resource): boolean;
  evaluate(resource: Resource, findings: Finding[]): PolicyEvaluation;
}

class PolicyRegistry {
  private readonly policies: Policy[] = [];
  private readonly metadata = new Map<string, PolicyMetadata>();

  register(policy: Policy, metadata: PolicyMetadata): void {
    this.policies.push(policy);
    this.metadata.set(policy.id(), metadata);
  }

  policiesFor(resource: Resource): Policy[] {
    return this.policies.filter((policy) => policy.supports(resource));
  }

  allMetadata(): PolicyMetadata[] {
    return [...this.metadata.values()];
  }

  getMetadata(code: string): PolicyMetadata | undefined {
    return this.metadata.get(code);
  }
}

export const policyRegistry = new PolicyRegistry();
