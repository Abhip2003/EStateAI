import { policyRegistry, type Policy } from '../../policy-registry.js';
import type { PolicyEvaluation } from '../../dto/policy-result.js';
import type { Resource, Finding } from '../../../../generated/prisma/client.js';

class RepositoriesMustHaveTopicsPolicy implements Policy {
  id(): string {
    return 'REPOSITORIES_MUST_HAVE_TOPICS';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource, findings: Finding[]): PolicyEvaluation {
    const violation = findings.find((f) => f.ruleCode === 'NO_TOPICS');
    if (violation) {
      return {
        status: 'FAIL',
        reason: `Repository "${resource.displayName}" has no topics.`,
        findingId: violation.id,
      };
    }
    return { status: 'PASS', reason: 'Repository has topics.' };
  }
}

policyRegistry.register(new RepositoriesMustHaveTopicsPolicy(), {
  code: 'REPOSITORIES_MUST_HAVE_TOPICS',
  name: 'Repositories Must Have Topics',
  description: 'Repositories must have at least one topic set.',
  provider: 'github',
  resourceType: 'repository',
  severity: 'LOW',
});
