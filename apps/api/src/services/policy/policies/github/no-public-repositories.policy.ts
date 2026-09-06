import { policyRegistry, type Policy } from '../../policy-registry.js';
import type { PolicyEvaluation } from '../../dto/policy-result.js';
import type { Resource, Finding } from '../../../../generated/prisma/client.js';

class NoPublicRepositoriesPolicy implements Policy {
  id(): string {
    return 'NO_PUBLIC_REPOSITORIES';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource, findings: Finding[]): PolicyEvaluation {
    const violation = findings.find((f) => f.ruleCode === 'PUBLIC_REPOSITORY');
    if (violation) {
      return {
        status: 'FAIL',
        reason: `Repository "${resource.displayName}" is public.`,
        findingId: violation.id,
      };
    }
    return { status: 'PASS', reason: 'Repository is not public.' };
  }
}

policyRegistry.register(new NoPublicRepositoriesPolicy(), {
  code: 'NO_PUBLIC_REPOSITORIES',
  name: 'No Public Repositories',
  description: 'Repositories must not be publicly visible.',
  provider: 'github',
  resourceType: 'repository',
  severity: 'MEDIUM',
});
