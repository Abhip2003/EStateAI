import { policyRegistry, type Policy } from '../../policy-registry.js';
import type { PolicyEvaluation } from '../../dto/policy-result.js';
import type { Resource, Finding } from '../../../../generated/prisma/client.js';

class RepositoriesMustHaveDescriptionPolicy implements Policy {
  id(): string {
    return 'REPOSITORIES_MUST_HAVE_DESCRIPTION';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource, findings: Finding[]): PolicyEvaluation {
    const violation = findings.find((f) => f.ruleCode === 'NO_DESCRIPTION');
    if (violation) {
      return {
        status: 'FAIL',
        reason: `Repository "${resource.displayName}" has no description.`,
        findingId: violation.id,
      };
    }
    return { status: 'PASS', reason: 'Repository has a description.' };
  }
}

policyRegistry.register(new RepositoriesMustHaveDescriptionPolicy(), {
  code: 'REPOSITORIES_MUST_HAVE_DESCRIPTION',
  name: 'Repositories Must Have Description',
  description: 'Repositories must have a non-empty description.',
  provider: 'github',
  resourceType: 'repository',
  severity: 'LOW',
});
