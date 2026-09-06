import { policyRegistry, type Policy } from '../../policy-registry.js';
import type { PolicyEvaluation } from '../../dto/policy-result.js';
import type { Resource, Finding } from '../../../../generated/prisma/client.js';

// Demonstrates WARNING: being archived is not a violation (this policy
// never FAILs), but it's still worth flagging for review rather than
// silently passing — and NOT_APPLICABLE for the common case where the
// policy simply has nothing to say about a non-archived repository.
class ArchivedRepositoriesAreAllowedPolicy implements Policy {
  id(): string {
    return 'ARCHIVED_REPOSITORIES_ARE_ALLOWED';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource, findings: Finding[]): PolicyEvaluation {
    const finding = findings.find((f) => f.ruleCode === 'ARCHIVED_REPOSITORY');
    if (finding) {
      return {
        status: 'WARNING',
        reason: `Repository "${resource.displayName}" is archived — allowed, but flagged for review.`,
        findingId: finding.id,
      };
    }
    return { status: 'NOT_APPLICABLE', reason: 'Repository is not archived.' };
  }
}

policyRegistry.register(new ArchivedRepositoriesAreAllowedPolicy(), {
  code: 'ARCHIVED_REPOSITORIES_ARE_ALLOWED',
  name: 'Archived Repositories Are Allowed',
  description: 'Archived repositories are permitted, but flagged for periodic review.',
  provider: 'github',
  resourceType: 'repository',
  severity: 'INFORMATIONAL',
  conditions: { allowArchived: true },
});
