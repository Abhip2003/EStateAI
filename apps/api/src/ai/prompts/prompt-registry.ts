import type { PromptVariables } from '../types/prompt.types.js';
import { PromptError } from '../errors/index.js';
import { PromptTemplate } from './prompt-template.js';

// Centralized lookup for every registered prompt template, keyed by
// `id@version`. Registering a second definition under the same id+version
// is rejected — templates are immutable once published; bump `version`
// to change wording. `latest` resolves to whichever version was
// registered most recently for that id, so callers that don't care about
// pinning can just ask for the id.
export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate>();
  private readonly latestVersion = new Map<string, string>();

  register<TVars extends PromptVariables>(template: PromptTemplate<TVars>): void {
    const key = `${template.id}@${template.version}`;
    if (this.templates.has(key)) {
      throw new PromptError(
        `template already registered at version ${template.version}`,
        template.id,
      );
    }
    this.templates.set(key, template);
    this.latestVersion.set(template.id, template.version);
  }

  get(id: string, version?: string): PromptTemplate {
    const resolvedVersion = version ?? this.latestVersion.get(id);
    if (!resolvedVersion) {
      throw new PromptError('no such prompt template registered', id);
    }
    const template = this.templates.get(`${id}@${resolvedVersion}`);
    if (!template) {
      throw new PromptError(`no such version "${resolvedVersion}" registered`, id);
    }
    return template;
  }

  has(id: string, version?: string): boolean {
    try {
      this.get(id, version);
      return true;
    } catch {
      return false;
    }
  }

  list(): { id: string; version: string }[] {
    return [...this.templates.values()].map((template) => ({
      id: template.id,
      version: template.version,
    }));
  }
}
