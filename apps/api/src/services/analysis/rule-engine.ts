import { ruleRegistry } from './rule-registry.js';
import type { RuleFinding } from './dto/finding.js';
import type { Resource } from '../../generated/prisma/client.js';

export interface RuleEvaluationStats {
  rulesExecuted: number;
  resourcesEvaluated: number;
  durationMs: number;
}

export interface RuleEvaluationOutput {
  findingsByResource: Map<string, RuleFinding[]>;
  stats: RuleEvaluationStats;
}

// Never branches on provider or resource type — only asks the registry
// which rules apply to each resource and runs them. Adding a new provider
// or rule never touches this file.
class RuleEngine {
  evaluate(resources: Resource[]): RuleEvaluationOutput {
    const startedAt = Date.now();
    const findingsByResource = new Map<string, RuleFinding[]>();
    let rulesExecuted = 0;

    for (const resource of resources) {
      const applicableRules = ruleRegistry.rulesFor(resource);
      const findings: RuleFinding[] = [];
      for (const rule of applicableRules) {
        rulesExecuted += 1;
        findings.push(...rule.evaluate(resource));
      }
      findingsByResource.set(resource.id, findings);
    }

    return {
      findingsByResource,
      stats: {
        rulesExecuted,
        resourcesEvaluated: resources.length,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

export const ruleEngine = new RuleEngine();
