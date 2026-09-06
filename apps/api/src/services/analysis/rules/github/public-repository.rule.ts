import { ruleRegistry, type Rule } from '../../rule-registry.js';
import type { RuleFinding } from '../../dto/finding.js';
import type { Resource } from '../../../../generated/prisma/client.js';

class PublicRepositoryRule implements Rule {
  id(): string {
    return 'PUBLIC_REPOSITORY';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource): RuleFinding[] {
    const metadata = (resource.metadata ?? {}) as { private?: boolean };
    if (metadata.private === true) {
      return [];
    }
    return [
      {
        ruleCode: this.id(),
        severity: 'MEDIUM',
        title: `Repository "${resource.displayName}" is public`,
        description: 'This repository is publicly visible on GitHub.',
        confidence: 100,
      },
    ];
  }
}

ruleRegistry.register(new PublicRepositoryRule());
