import { ruleRegistry, type Rule } from '../../rule-registry.js';
import type { RuleFinding } from '../../dto/finding.js';
import type { Resource } from '../../../../generated/prisma/client.js';

class EmptyRepositoryRule implements Rule {
  id(): string {
    return 'EMPTY_REPOSITORY';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  // GitHub reports `size` in KB; 0 means nothing has ever been pushed —
  // the same deterministic signal GitHub's own UI uses for "this
  // repository is empty", no extra API call needed.
  evaluate(resource: Resource): RuleFinding[] {
    const metadata = (resource.metadata ?? {}) as { size?: number };
    if (metadata.size !== 0) {
      return [];
    }
    return [
      {
        ruleCode: this.id(),
        severity: 'LOW',
        title: `Repository "${resource.displayName}" is empty`,
        description: 'This repository has no commits pushed to it.',
        confidence: 100,
      },
    ];
  }
}

ruleRegistry.register(new EmptyRepositoryRule());
