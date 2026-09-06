import type {
  PromptTemplateDefinition,
  PromptVariables,
  RenderedPrompt,
} from '../types/prompt.types.js';
import { PromptError } from '../errors/index.js';

// Matches {{variableName}} placeholders — deliberately simple
// string-substitution rather than a templating engine (Handlebars/EJS):
// prompts are short, variables are flat, and pulling in a template
// engine here would be a dependency the project doesn't otherwise need.
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function renderTemplate(template: string, variables: PromptVariables): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    const value = key.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in acc) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, variables);
    return value === undefined || value === null ? match : stringifyValue(value);
  });
}

// Wraps a PromptTemplateDefinition with validation + rendering. Templates
// are versioned (`id` + `version`) so a prompt can be revised without
// breaking callers pinned to an older version — see PromptRegistry.
export class PromptTemplate<TVars extends PromptVariables = PromptVariables> {
  constructor(private readonly definition: PromptTemplateDefinition<TVars>) {}

  get id(): string {
    return this.definition.id;
  }

  get version(): string {
    return this.definition.version;
  }

  validate(variables: unknown): TVars {
    const result = this.definition.variablesSchema.safeParse(variables);
    if (!result.success) {
      const issues = result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      );
      throw new PromptError(`invalid variables: ${issues.join('; ')}`, this.definition.id);
    }
    return result.data;
  }

  render(variables: unknown): RenderedPrompt {
    const validated = this.validate(variables);
    return {
      system: this.definition.systemTemplate
        ? renderTemplate(this.definition.systemTemplate, validated)
        : undefined,
      user: renderTemplate(this.definition.userTemplate, validated),
    };
  }
}
