import { ruleRegistry, type Rule } from '../../rule-registry.js';
import type { RuleFinding } from '../../dto/finding.js';
import type { Resource } from '../../../../generated/prisma/client.js';

class ArchivedRepositoryRule implements Rule {
  id(): string {
    return 'ARCHIVED_REPOSITORY';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource): RuleFinding[] {
    const metadata = (resource.metadata ?? {}) as { archived?: boolean };
    if (metadata.archived !== true) {
      return [];
    }
    return [
      {
        ruleCode: this.id(),
        severity: 'LOW',
        title: `Repository "${resource.displayName}" is archived`,
        description: 'This repository is archived and read-only, but still connected.',
        confidence: 100,
      },
    ];
  }
}

ruleRegistry.register(new ArchivedRepositoryRule());
