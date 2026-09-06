import type { Resource } from '../../generated/prisma/client.js';
import type { RuleFinding } from './dto/finding.js';

// Every rule is provider-specific in practice (supports() checks
// resource.provider), but the contract itself has no notion of "provider"
// — RuleEngine/RuleRegistry only ever call supports()/evaluate() and never
// branch on what kind of resource they're looking at. Adding a rule for a
// new provider or resource type means creating one more file implementing
// this interface and registering it; nothing here changes.
export interface Rule {
  id(): string;
  supports(resource: Resource): boolean;
  evaluate(resource: Resource): RuleFinding[];
}

class RuleRegistry {
  private readonly rules: Rule[] = [];

  register(rule: Rule): void {
    this.rules.push(rule);
  }

  rulesFor(resource: Resource): Rule[] {
    return this.rules.filter((rule) => rule.supports(resource));
  }
}

export const ruleRegistry = new RuleRegistry();
