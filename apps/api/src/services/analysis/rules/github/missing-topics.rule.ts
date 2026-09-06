import { ruleRegistry, type Rule } from '../../rule-registry.js';
import type { RuleFinding } from '../../dto/finding.js';
import type { Resource } from '../../../../generated/prisma/client.js';

class MissingTopicsRule implements Rule {
  id(): string {
    return 'NO_TOPICS';
  }

  supports(resource: Resource): boolean {
    return resource.provider === 'github' && resource.resourceType === 'repository';
  }

  evaluate(resource: Resource): RuleFinding[] {
    const metadata = (resource.metadata ?? {}) as { topics?: string[] };
    if (metadata.topics && metadata.topics.length > 0) {
      return [];
    }
    return [
      {
        ruleCode: this.id(),
        severity: 'INFORMATIONAL',
        title: `Repository "${resource.displayName}" has no topics`,
        description: 'This repository does not have any topics set.',
        confidence: 100,
      },
    ];
  }
}

ruleRegistry.register(new MissingTopicsRule());
