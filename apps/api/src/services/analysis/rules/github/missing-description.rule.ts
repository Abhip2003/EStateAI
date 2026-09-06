import { ruleRegistry, type Rule } from '../../rule-registry.js';
import type { RuleFinding } from '../../dto/finding.js';
import type { Resource } from '../../../../generated/prisma/client.js';

class MissingDescriptionRule implements Rule {
  id(): string {
    return 'NO_DESCRIPTION';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource): RuleFinding[] {
    if (resource.description && resource.description.trim().length > 0) {
      return [];
    }
    return [
      {
        ruleCode: this.id(),
        severity: 'INFORMATIONAL',
        title: `Repository "${resource.displayName}" has no description`,
        description: 'This repository does not have a description set.',
        confidence: 100,
      },
    ];
  }
}

ruleRegistry.register(new MissingDescriptionRule());
