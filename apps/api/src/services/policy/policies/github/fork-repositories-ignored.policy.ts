import { policyRegistry, type Policy } from '../../policy-registry.js';
import type { PolicyEvaluation } from '../../dto/policy-result.js';
import type { Resource, Finding } from '../../../../generated/prisma/client.js';

// The one policy in this set that inspects the resource directly rather
// than a Finding — "is this a fork" isn't a problem a Rule detects, it's a
// structural fact about the resource that determines whether every other
// policy should even apply. Reading resource.metadata.fork here is no
// different from a Rule reading resource.metadata.private/archived — the
// constraint is that PolicyEngine itself stays provider-agnostic, not that
// individual policies can't know what provider they're for.
class ForkRepositoriesIgnoredPolicy implements Policy {
  id(): string {
    return 'FORK_REPOSITORIES_IGNORED';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource, _findings: Finding[]): PolicyEvaluation {
    const metadata = (resource.metadata ?? {}) as { fork?: boolean };
    if (metadata.fork === true) {
      return {
        status: 'NOT_APPLICABLE',
        reason: `Repository "${resource.displayName}" is a fork and is excluded from policy evaluation.`,
      };
    }
    return { status: 'PASS', reason: 'Repository is not a fork.' };
  }
}

policyRegistry.register(new ForkRepositoriesIgnoredPolicy(), {
  code: 'FORK_REPOSITORIES_IGNORED',
  name: 'Fork Repositories Ignored',
  description: 'Forked repositories are excluded from compliance evaluation.',
  provider: 'github',
  resourceType: 'repository',
  severity: 'INFORMATIONAL',
});
